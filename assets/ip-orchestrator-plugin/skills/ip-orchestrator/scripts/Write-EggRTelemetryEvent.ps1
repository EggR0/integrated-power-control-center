[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("task_started", "task_waiting", "token_usage", "task_completed", "task_failed", "task_cancelled", "calibration")]
    [string]$EventType,

    [Parameter(Mandatory = $true)]
    [string]$TaskId,

    [string]$AttemptId = "",
    [string]$RepoRoot = (Get-Location).Path,
    [string]$Framework = "eggr",
    [string]$AgentSurface = "unknown",
    [string]$Provider = "",
    [string]$Model = "",

    [ValidateSet("", "inspection", "documentation", "small_fix", "feature", "migration", "incident", "other")]
    [string]$TaskClass = "",

    [ValidateSet("", "main_agent", "codex", "antigravity", "local_llm", "hybrid")]
    [string]$Route = "",

    [long]$EstimatedLow = -1,
    [long]$EstimatedPoint = -1,
    [long]$EstimatedHigh = -1,
    [double]$Confidence = -1,
    [long]$ActualTotal = -1,

    [ValidateSet("provider_reported", "calculated", "estimated", "unavailable")]
    [string]$Evidence = "unavailable",

    [long]$InputTokens = -1,
    [long]$OutputTokens = -1,
    [long]$CachedTokens = -1,
    [long]$ReasoningTokens = -1,
    [long]$TotalTokens = -1,
    [long]$BillableTokens = -1,

    [ValidateSet("", "waiting", "completed", "failed", "cancelled")]
    [string]$OutcomeStatus = "",

    [ValidateSet("", "true", "false")]
    [string]$Success = "",
    [double]$QualityScore = -1,
    [string[]]$Verification = @(),
    [string[]]$ArtifactId = @(),
    [switch]$PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($AttemptId)) {
    $AttemptId = "$TaskId-1"
}

if ($EventType -eq "task_started") {
    if ($EstimatedLow -lt 0 -or $EstimatedPoint -lt 0 -or $EstimatedHigh -lt 0) {
        throw "task_started requires EstimatedLow, EstimatedPoint, and EstimatedHigh."
    }
    if (!($EstimatedLow -le $EstimatedPoint -and $EstimatedPoint -le $EstimatedHigh)) {
        throw "Token estimate must satisfy EstimatedLow <= EstimatedPoint <= EstimatedHigh."
    }
    if ($Confidence -lt 0 -or $Confidence -gt 1) {
        throw "task_started requires Confidence from 0 through 1."
    }
    if ([string]::IsNullOrWhiteSpace($TaskClass) -or [string]::IsNullOrWhiteSpace($Route)) {
        throw "task_started requires TaskClass and Route."
    }
}

if ($QualityScore -gt 1) {
    throw "QualityScore must be from 0 through 1."
}
if ($EventType -eq "task_completed" -and [string]::IsNullOrWhiteSpace($Success)) {
    throw "task_completed requires -Success true or -Success false."
}
if ($EventType -eq "token_usage") {
    $providedUsageValues = @(@(
        $InputTokens, $OutputTokens, $CachedTokens, $ReasoningTokens, $TotalTokens, $BillableTokens
    ) | Where-Object { $_ -ge 0 })
    if ($Evidence -eq "unavailable" -and $providedUsageValues.Count -gt 0) {
        throw "Evidence unavailable cannot include token values."
    }
    if ($Evidence -ne "unavailable" -and $providedUsageValues.Count -eq 0) {
        throw "A measured token_usage event requires at least one token value."
    }
}
if ($EventType -eq "calibration") {
    if ($EstimatedLow -lt 0 -or $EstimatedPoint -le 0 -or $EstimatedHigh -lt 0 -or $ActualTotal -le 0) {
        throw "calibration requires positive EstimatedPoint and ActualTotal plus non-negative estimate bounds."
    }
    if (!($EstimatedLow -le $EstimatedPoint -and $EstimatedPoint -le $EstimatedHigh)) {
        throw "Calibration estimate must satisfy EstimatedLow <= EstimatedPoint <= EstimatedHigh."
    }
}

$resolverCandidates = @(
    (Join-Path $PSScriptRoot "lib\EggR.Paths.psm1"),
    (Join-Path $PSScriptRoot "..\util\EggR.Paths.psm1")
)
$resolver = $resolverCandidates |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (!$resolver) {
    throw "EggR path resolver was not found beside this telemetry writer."
}

Import-Module $resolver -Force -DisableNameChecking
$workspaceState = Get-EggRWorkspaceStatePath -RepoRoot $RepoRoot
$telemetryPath = Join-Path $workspaceState "telemetry\events.jsonl"

$producer = [ordered]@{
    framework = $Framework
    agent_surface = $AgentSurface
    provider = if ([string]::IsNullOrWhiteSpace($Provider)) { $null } else { $Provider }
    model = if ([string]::IsNullOrWhiteSpace($Model)) { $null } else { $Model }
    orchestrator_version = "1.2.0"
}

$event = [ordered]@{
    schema_version = "1.1.0"
    event_id = [Guid]::NewGuid().ToString()
    task_id = $TaskId
    attempt_id = $AttemptId
    event_type = $EventType
    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
    producer = $producer
}

if ($EventType -eq "task_started") {
    $event["task"] = [ordered]@{
        task_class = $TaskClass
        route = $Route
        success_criteria = @()
        estimated_total_tokens = [ordered]@{
            low = $EstimatedLow
            point = $EstimatedPoint
            high = $EstimatedHigh
            confidence = $Confidence
        }
    }
}

if ($EventType -eq "token_usage") {
    $usage = [ordered]@{ evidence = $Evidence }
    foreach ($pair in @(
        @("input_tokens", $InputTokens),
        @("output_tokens", $OutputTokens),
        @("cached_tokens", $CachedTokens),
        @("reasoning_tokens", $ReasoningTokens),
        @("total_tokens", $TotalTokens),
        @("billable_tokens", $BillableTokens)
    )) {
        $usage[$pair[0]] = if ($pair[1] -ge 0) { $pair[1] } else { $null }
    }
    $event["usage"] = $usage
}

if ($EventType -in @("task_waiting", "task_completed", "task_failed", "task_cancelled")) {
    $resolvedStatus = if ($OutcomeStatus) {
        $OutcomeStatus
    } else {
        switch ($EventType) {
            "task_waiting" { "waiting" }
            "task_completed" { "completed" }
            "task_failed" { "failed" }
            "task_cancelled" { "cancelled" }
        }
    }
    $event["outcome"] = [ordered]@{
        status = $resolvedStatus
        success = if ($Success) { [bool]::Parse($Success) } else { $null }
        quality_score = if ($QualityScore -ge 0) { $QualityScore } else { $null }
        verification = @($Verification)
        artifact_ids = @($ArtifactId)
    }
}

if ($EventType -eq "calibration") {
    $event["calibration"] = [ordered]@{
        actual_to_estimate_ratio = $ActualTotal / [double]$EstimatedPoint
        absolute_percentage_error = [Math]::Abs($ActualTotal - $EstimatedPoint) / [double]$ActualTotal
        range_hit = ($EstimatedLow -le $ActualTotal -and $ActualTotal -le $EstimatedHigh)
        sample_count = 1
    }
}

$event["privacy"] = [ordered]@{
    content_recorded = $false
    secrets_recorded = $false
    redaction_profile = "metadata-only-v1"
}

$jsonLine = ($event | ConvertTo-Json -Depth 12 -Compress) + "`n"
$telemetryDirectory = Split-Path -Parent $telemetryPath
New-Item -ItemType Directory -Path $telemetryDirectory -Force | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds(10)
$stream = $null
while ($null -eq $stream) {
    try {
        $stream = [IO.File]::Open(
            $telemetryPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::Read
        )
    } catch [IO.IOException] {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Timed out waiting for the EggR telemetry writer lock: $telemetryPath"
        }
        Start-Sleep -Milliseconds 100
    }
}

try {
    $stream.Seek(0, [IO.SeekOrigin]::End) | Out-Null
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($jsonLine)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
} finally {
    $stream.Dispose()
}

if ($PassThru) {
    [pscustomobject]$event
} else {
    Write-Output $telemetryPath
}
