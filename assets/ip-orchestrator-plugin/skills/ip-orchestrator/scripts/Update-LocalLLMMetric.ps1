param(
    [Parameter(Mandatory = $true)]
    [string]$TaskTitle,

    [Parameter(Mandatory = $true)]
    [ValidateSet("pass", "fail")]
    [string]$Result,

    [string]$Model = "",

    [string]$Timestamp = "",

    [string]$Note = "",

    [string]$MetricsFile = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = ""
try {
    $gitRoot = (& git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -eq 0 -and ![string]::IsNullOrWhiteSpace($gitRoot)) {
        $repoRoot = ($gitRoot | Select-Object -First 1).Trim()
    }
}
catch {
    $repoRoot = ""
}

if ([string]::IsNullOrWhiteSpace($repoRoot)) {
    $repoRoot = (Get-Location).Path
}

Import-Module (Join-Path $PSScriptRoot "lib\EggR.Paths.psm1") -Force -DisableNameChecking
$storagePath = Get-GlobalStorage -RepoRoot $repoRoot

if ([string]::IsNullOrWhiteSpace($MetricsFile)) {
    $MetricsFile = Join-Path $storagePath "reports\local_llm_metrics.csv"
}

if (!(Test-Path -LiteralPath $MetricsFile)) {
    throw "Local LLM metrics file not found: $MetricsFile"
}

$rows = @(Import-Csv -LiteralPath $MetricsFile)
$matches = @($rows | Where-Object {
    $_.TaskTitle -eq $TaskTitle -and
    ([string]::IsNullOrWhiteSpace($Model) -or $_.Model -eq $Model) -and
    ([string]::IsNullOrWhiteSpace($Timestamp) -or $_.Timestamp -eq $Timestamp)
})

if ($matches.Count -eq 0) {
    throw "No local LLM metric row matched TaskTitle='$TaskTitle' Model='$Model' Timestamp='$Timestamp'."
}

if ($matches.Count -gt 1 -and [string]::IsNullOrWhiteSpace($Timestamp)) {
    throw "Matched $($matches.Count) rows. Pass -Timestamp to choose one exact row."
}

$target = $matches[0]
$target.Success = if ($Result -eq "pass") { "True" } else { "False" }
if (![string]::IsNullOrWhiteSpace($Note)) {
    $target.ErrorMessage = $Note
}

$rows | Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath $MetricsFile
Write-Host "Updated local LLM metric: $($target.Timestamp) $($target.TaskTitle) $($target.Model) Success=$($target.Success)"
