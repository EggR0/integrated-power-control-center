[CmdletBinding(DefaultParameterSetName = "PromptFile")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "PromptFile")]
    [string]$PromptFile,

    [Parameter(Mandatory = $true, ParameterSetName = "PromptText")]
    [AllowEmptyString()]
    [string]$PromptText,

    [string[]]$ContextFile = @(),

    [string]$OutputFile = "",

    [string]$TaskTitle = "Codex Job",

    [string]$TaskKey = "",

    [ValidateSet("Coalesce", "Separate")]
    [string]$ArtifactPolicy = "Coalesce",

    [ValidateSet("read-only", "workspace-write", "danger-full-access")]
    [string]$Sandbox = "read-only",

    [string]$Model = "gpt-5.5",

    [ValidateSet("minimal", "low", "medium", "high", "xhigh")]
    [string]$ReasoningEffort = "high",

    [string]$CodexExe = "",

    [switch]$JsonLog,

    [int]$TimeoutSeconds = 1800,
    [int]$PollSeconds = 15,
    [int]$IdleTimeoutSeconds = 600,
    [string]$CompletionSentinel = "CODEX_JOB_DONE status=success"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

try {
    $gitRoot = (& git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -eq 0 -and ![string]::IsNullOrWhiteSpace($gitRoot)) {
        $repoRoot = ($gitRoot | Select-Object -First 1).Trim()
    }
} catch {
    $repoRoot = ""
}

if ([string]::IsNullOrWhiteSpace($repoRoot)) {
    $repoRoot = (Get-Location).Path
}

Import-Module (Join-Path $PSScriptRoot "lib\EggR.Paths.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot "lib\IntegratedPower.Artifacts.psm1") -Force -DisableNameChecking
$storagePath = Get-GlobalStorage -RepoRoot $repoRoot

$ensureSetup = Join-Path $PSScriptRoot "Ensure-CodexOrchestratorSetup.ps1"
if (!(Test-Path -LiteralPath $ensureSetup -PathType Leaf)) {
    throw "Missing setup helper: $ensureSetup"
}
$codexExe = & $ensureSetup -RequestedCodexExe $CodexExe -PassThru

$promptPath = ""
if ($PSCmdlet.ParameterSetName -eq "PromptText") {
    $prompt = [string]$PromptText
}
else {
    $promptPath = [string](Resolve-Path -LiteralPath $PromptFile)
    $prompt = [string](Get-Content -Raw -Encoding UTF8 -LiteralPath $promptPath)
    $promptBrainRoot = Get-IntegratedPowerAntigravityBrainSessionRoot -Path $promptPath
    if (-not [string]::IsNullOrWhiteSpace($promptBrainRoot)) {
        Write-Warning "PromptFile is inside Antigravity IDE brain and may appear as another artifact. Reuse a workspace file or pass -PromptText on the next run. The existing file was not modified or deleted."
    }
}

$resolvedContextFiles = @()
foreach ($contextCandidate in @($ContextFile)) {
    if ([string]::IsNullOrWhiteSpace($contextCandidate)) { continue }
    $contextPath = if ([IO.Path]::IsPathRooted($contextCandidate)) {
        [IO.Path]::GetFullPath($contextCandidate)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $repoRoot $contextCandidate))
    }
    if (-not (Test-Path -LiteralPath $contextPath -PathType Leaf)) {
        throw "Context file was not found: $contextPath"
    }
    $resolvedContextFiles += $contextPath
}
if ($resolvedContextFiles.Count -gt 0) {
    $contextList = $resolvedContextFiles | ForEach-Object { "- $_" }
    $prompt = @(
        $prompt,
        "# Context files`r`nRead these files with your sandbox tools; do not ask the caller to paste their contents.`r`n$($contextList -join "`r`n")"
    ) -join "`r`n`r`n"
}

$artifactTarget = Resolve-IntegratedPowerArtifactTarget `
    -OutputFile $OutputFile `
    -RepoRoot $repoRoot `
    -StateRoot $storagePath `
    -TaskKey $TaskKey `
    -TaskTitle $TaskTitle `
    -ArtifactPolicy $ArtifactPolicy
$outputPath = [string]$artifactTarget.Path
if ([bool]$artifactTarget.Coalesced) {
    Write-Warning "Antigravity IDE indexes every brain file as an artifact. Coalescing '$($artifactTarget.RequestedPath)' into '$outputPath'. Use -ArtifactPolicy Separate only when the user explicitly requests another visible artifact."
}

$outputDir = Split-Path -Parent $outputPath
if (![string]::IsNullOrWhiteSpace($outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

$arguments = @(
    "exec",
    "--cd", "`"$repoRoot`"",
    "--sandbox", $Sandbox,
    "--model", $Model,
    "-c", "model_reasoning_effort=`"$ReasoningEffort`"",
    "--output-last-message", "`"$outputPath`""
)

if ($JsonLog) {
    $arguments += "--json"
}
$arguments += "-"

$logExtension = if ($JsonLog) { ".jsonl" } else { ".log" }
$logDirectory = Join-Path $storagePath "logs\tasks"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$logPath = Join-Path $logDirectory "$($artifactTarget.TaskKey).codex$logExtension"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$writer = New-Object System.IO.StreamWriter($logPath, $false, $Utf8NoBom)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $codexExe
$psi.Arguments = $arguments -join ' '
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $psi

$global:LastActivityTime = Get-Date

$action = {
    $e = $Event.SourceEventArgs
    $w = $Event.MessageData
    if (![string]::IsNullOrEmpty($e.Data)) {
        [Console]::Out.WriteLine($e.Data)
        $w.WriteLine($e.Data)
        $w.Flush()
        $global:LastActivityTime = Get-Date
    }
}

$outEvent = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData $writer -Action $action
$errEvent = Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -MessageData $writer -Action $action

$process.Start() | Out-Null
$process.BeginOutputReadLine()
$process.BeginErrorReadLine()

$promptBytes = $Utf8NoBom.GetBytes($prompt)
$process.StandardInput.BaseStream.Write($promptBytes, 0, $promptBytes.Length)
$process.StandardInput.Close()

$startTime = Get-Date
$status = "running"
$stableCount = 0
$lastSize = -1

while (!$process.HasExited) {
    Start-Sleep -Seconds $PollSeconds
    $now = Get-Date
    
    if (($now - $startTime).TotalSeconds -ge $TimeoutSeconds) {
        $status = "hard_timeout"
        break
    }
    
    if (Test-Path -LiteralPath $outputPath) {
        $fileInfo = Get-Item -LiteralPath $outputPath
        if ($fileInfo.Length -eq $lastSize -and $fileInfo.Length -gt 0) {
            $stableCount++
        } else {
            if ($fileInfo.Length -ne $lastSize) {
                $global:LastActivityTime = $now
            }
            $stableCount = 0
            $lastSize = $fileInfo.Length
        }
        
        if ($stableCount -ge 2) {
            try {
                $content = [System.IO.File]::ReadAllText($outputPath, $Utf8NoBom)
                if ($content -match $CompletionSentinel) {
                    $status = "completed_stuck"
                    break
                }
            } catch { }
        }
    }
    
    if (($now - $global:LastActivityTime).TotalSeconds -ge $IdleTimeoutSeconds) {
        $status = "idle_timeout"
        break
    }
}

if (!$process.HasExited) {
    try { $process.Kill() } catch { }
} else {
    if ($process.ExitCode -eq 0) {
        $status = "completed"
    } else {
        $status = "failed"
    }
}

$writer.Dispose()

Write-Host "Codex job finished with status: $status"
Write-Host "Output saved to: $outputPath"
Write-Host "Log saved to: $logPath"

if ($JsonLog) {
    $usageParser = Join-Path $repoRoot "scripts\metrics\Parse-CodexUsage.ps1"
    if (Test-Path -LiteralPath $usageParser) {
        & $usageParser -JsonlPath $logPath -OperationName $TaskTitle -Model $Model | Out-Null
    }
}

if ($status -ne "completed" -and $status -ne "completed_stuck") {
    exit 1
}

