[CmdletBinding(DefaultParameterSetName = "PromptFile")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "PromptFile")]
    [string]$PromptFile,

    [Parameter(Mandatory = $true, ParameterSetName = "PromptText")]
    [AllowEmptyString()]
    [string]$PromptText,

    [string[]]$ContextFile = @(),

    [string]$OutputFile = "",

    [string]$TaskKey = "",

    [ValidateSet("Coalesce", "Separate")]
    [string]$ArtifactPolicy = "Coalesce",

    [ValidateSet("Replace", "Append")]
    [string]$ArtifactWriteMode = "Replace",

    [string]$Model = "",

    [string]$SystemPrompt = "You are a helpful AI coding assistant.",

    [switch]$ForceRestart,

    [int]$NumCtx = 4096,

    [string]$TaskTitle = "Local LLM Inference",

    [string]$TaskScale = "Medium",

    [ValidateSet("summarization", "extraction", "coding", "reasoning", "korean", "long_context", "routing_review", "general")]
    [string]$TaskType = "general",

    [string]$SuccessRegex = "",

    [int]$MinOutputChars = 1,

    [string]$SelectedBy = "manual",

    [string]$SelectionReason = "",

    [ValidateNotNullOrEmpty()]
    [string]$KeepAlive = "30m",

    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds = 900,

    [ValidateRange(1, 86400)]
    [int]$ColdLoadTimeoutSeconds = 1800,

    [ValidateRange(1, 300)]
    [int]$ConnectTimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = ""
try {
    $repoRoot = (git rev-parse --show-toplevel 2>$null).Trim()
}
catch {
    # Not a git repo
}
if (!$repoRoot) {
    $repoRoot = $PWD.Path
}

Import-Module (Join-Path $PSScriptRoot "lib\EggR.Paths.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot "lib\EggR.Settings.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot "lib\IntegratedPower.Artifacts.psm1") -Force -DisableNameChecking
$storagePath = Get-GlobalStorage -RepoRoot $repoRoot
$orchestratorSettings = Get-EggROrchestratorSettings
if (-not (Test-EggRRouteEnabled -Route "local_llm" -Settings $orchestratorSettings)) {
    throw "The local_llm route is disabled in $($orchestratorSettings.Path)."
}
if ([string]::IsNullOrWhiteSpace($Model)) {
    $configuredModel = if ($orchestratorSettings.LocalLlm -and $orchestratorSettings.LocalLlm.PSObject.Properties.Name -contains "Model") {
        [string]$orchestratorSettings.LocalLlm.Model
    } else { "" }
    $selectionMode = if (
        $orchestratorSettings.LocalLlm -and
        $orchestratorSettings.LocalLlm.HardwarePolicy -and
        $orchestratorSettings.LocalLlm.HardwarePolicy.PSObject.Properties.Name -contains "Mode"
    ) {
        [string]$orchestratorSettings.LocalLlm.HardwarePolicy.Mode
    } else { "auto" }
    if (-not [string]::IsNullOrWhiteSpace($configuredModel) -and $selectionMode -eq "user_default") {
        $Model = $configuredModel
        if ($SelectedBy -eq "manual") { $SelectedBy = "user_default" }
    } else {
        $selector = Join-Path $PSScriptRoot "Select-LocalLLMModel.ps1"
        if (-not (Test-Path -LiteralPath $selector -PathType Leaf)) {
            throw "Automatic model selection was requested but the selector is missing: $selector"
        }
        $selection = (& $selector -TaskType $TaskType -TaskScale $TaskScale -InstalledOnly -AsJson) | ConvertFrom-Json
        if (($selection.PSObject.Properties.Name -contains "NeedsUserConfirmation") -and [bool]$selection.NeedsUserConfirmation) {
            $suggestedModels = @($selection.SuggestedInstalls | ForEach-Object {
                if ($_.PSObject.Properties.Name -contains "Model") { [string]$_.Model } else { [string]$_ }
            } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            $suggestionText = if ($suggestedModels.Count -gt 0) { $suggestedModels -join ", " } else { "none" }
            throw "Automatic model selection requires user confirmation before installation. Suggested models: $suggestionText. Ask the user which exact model may be installed; do not run ollama pull before explicit approval."
        }
        $Model = [string]$selection.SelectedModel
        if ([string]::IsNullOrWhiteSpace($Model)) {
            throw "Automatic model selection returned no installed model. $([string]$selection.AgentPrompt)"
        }
        $SelectedBy = [string]$selection.SelectionBasis
        $SelectionReason = [string]$selection.Reason
    }
}

function Write-CsvRowWithRetry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [pscustomobject]$Row
    )

    $dir = Split-Path -Parent $Path
    if (![string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    for ($i = 0; $i -lt 3; $i++) {
        try {
            if (Test-Path -LiteralPath $Path) {
                $Row | Export-Csv -NoTypeInformation -Encoding UTF8 -Append -LiteralPath $Path
            }
            else {
                $Row | Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath $Path
            }
            return
        }
        catch {
            if ($i -eq 2) { throw }
            Start-Sleep -Milliseconds 1000
        }
    }
}

function ConvertTo-LocalMetricRow {
    param(
        [Parameter(Mandatory = $true)]
        [pscustomobject]$Source
    )

    [pscustomobject]@{
        Timestamp            = if ($Source.Timestamp) { $Source.Timestamp } else { Get-Date -Format "yyyy-MM-dd HH:mm:ss" }
        TaskTitle            = if ($Source.TaskTitle) { $Source.TaskTitle } else { "" }
        Model                = if ($Source.Model) { $Source.Model } else { "" }
        TaskScale            = if ($Source.TaskScale) { $Source.TaskScale } else { "" }
        ActualElapsedSeconds = if ($Source.ActualElapsedSeconds) { $Source.ActualElapsedSeconds } else { 0 }
        TotalTokens          = if ($Source.TotalTokens) { $Source.TotalTokens } else { 0 }
        TaskType             = if ($Source.TaskType) { $Source.TaskType } else { "general" }
        Provider             = if ($Source.Provider) { $Source.Provider } else { "ollama" }
        Success              = if (($Source.PSObject.Properties.Name -contains "Success") -and $null -ne $Source.Success -and [string]$Source.Success -ne "") { $Source.Success } else { "" }
        SuccessRegex         = if ($Source.SuccessRegex) { $Source.SuccessRegex } else { "" }
        MinOutputChars       = if ($Source.MinOutputChars) { $Source.MinOutputChars } else { 1 }
        OutputChars          = if ($Source.OutputChars) { $Source.OutputChars } else { 0 }
        TokensPerSecond      = if ($Source.TokensPerSecond) { $Source.TokensPerSecond } else { 0 }
        SelectedBy           = if ($Source.SelectedBy) { $Source.SelectedBy } else { "unknown" }
        SelectionReason      = if ($Source.SelectionReason) { $Source.SelectionReason } else { "" }
        PromptFile           = if ($Source.PromptFile) { $Source.PromptFile } else { "" }
        OutputFile           = if ($Source.OutputFile) { $Source.OutputFile } else { "" }
        ErrorMessage         = if ($Source.ErrorMessage) { $Source.ErrorMessage } else { "" }
    }
}

function Ensure-LocalMetricsSchema {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (!(Test-Path -LiteralPath $Path)) { return }

    $header = Get-Content -LiteralPath $Path -TotalCount 1
    if ($header -match "TaskType" -and $header -match "Success") { return }

    $backup = "$Path.legacy-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    $rows = @(Import-Csv -LiteralPath $Path | ForEach-Object { ConvertTo-LocalMetricRow -Source $_ })
    if ($rows.Count -gt 0) {
        $rows | Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath $Path
    }
}

function Write-LocalLlmMetric {
    param(
        [Parameter(Mandatory = $true)]
        [string]$MetricsPath,

        [Parameter(Mandatory = $true)]
        [double]$ElapsedSeconds,

        [Parameter(Mandatory = $true)]
        [int]$TotalTokens,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Content,

        [Parameter(Mandatory = $true)]
        [bool]$Success,

        [AllowEmptyString()]
        [string]$ErrorMessage = ""
    )

    Ensure-LocalMetricsSchema -Path $MetricsPath
    $outputChars = if ($null -ne $Content) { $Content.Length } else { 0 }
    $tokensPerSecond = if ($ElapsedSeconds -gt 0) { [math]::Round($TotalTokens / $ElapsedSeconds, 2) } else { 0 }
    $row = ConvertTo-LocalMetricRow -Source ([pscustomobject]@{
        Timestamp            = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        TaskTitle            = $TaskTitle
        Model                = $Model
        TaskScale            = $TaskScale
        ActualElapsedSeconds = [math]::Round($ElapsedSeconds, 2)
        TotalTokens          = $TotalTokens
        TaskType             = $TaskType
        Provider             = "ollama"
        Success              = $Success
        SuccessRegex         = $SuccessRegex
        MinOutputChars       = $MinOutputChars
        OutputChars          = $outputChars
        TokensPerSecond      = $tokensPerSecond
        SelectedBy           = $SelectedBy
        SelectionReason      = $SelectionReason
        PromptFile           = [string]$promptPath
        OutputFile           = $outputPath
        ErrorMessage         = $ErrorMessage
    })

    Write-CsvRowWithRetry -Path $MetricsPath -Row $row
}

function Resolve-OllamaClientEndpoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint
    )

    $candidate = $Endpoint.Trim()
    if ($candidate -notmatch "^[a-zA-Z][a-zA-Z0-9+.-]*://") {
        $candidate = "http://$candidate"
    }

    $builder = [UriBuilder]::new([Uri]$candidate)
    if ($builder.Host -eq "0.0.0.0" -or $builder.Host -eq "::" -or $builder.Host -eq "[::]") {
        $builder.Host = "127.0.0.1"
    }
    if ($builder.Port -eq -1) {
        $builder.Port = 11434
    }

    return $builder.Uri.AbsoluteUri.TrimEnd("/")
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

$promptPath = ""
$prompt = ""
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
    $contextSections = @()
    foreach ($contextPath in $resolvedContextFiles) {
        $contextSections += "# Context file: $contextPath`r`n$([string](Get-Content -Raw -Encoding UTF8 -LiteralPath $contextPath))"
    }
    $prompt = @($prompt, ($contextSections -join "`r`n`r`n")) -join "`r`n`r`n"
}

# Ensure Ollama is running
$configuredOllamaUrl = if (-not [string]::IsNullOrWhiteSpace($env:OLLAMA_HOST)) {
    $env:OLLAMA_HOST
} elseif (
    $orchestratorSettings.LocalLlm -and
    [string]$orchestratorSettings.LocalLlm.Provider -eq "ollama" -and
    -not [string]::IsNullOrWhiteSpace([string]$orchestratorSettings.LocalLlm.Endpoint)
) {
    [string]$orchestratorSettings.LocalLlm.Endpoint
} else {
    "http://localhost:11434"
}
$ollamaUrl = Resolve-OllamaClientEndpoint -Endpoint $configuredOllamaUrl
$serverRunning = $false

try {
    $response = Invoke-RestMethod -Uri "$ollamaUrl/api/version" -Method Get -TimeoutSec 2 -ErrorAction Stop
    if ($response.version) {
        $serverRunning = $true
    }
}
catch {
    # Server is down
}

if (-not $serverRunning -or $ForceRestart) {
    Write-Host "Starting Ollama server..."
    if ($ForceRestart) {
        Stop-Process -Name "ollama*" -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    $ollamaCmd = Get-Command "ollama.exe", "ollama" -ErrorAction SilentlyContinue | Select-Object -First 1
    $ollamaExe = if ($ollamaCmd) { $ollamaCmd.Source } else { Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe" }

    if (Test-Path -LiteralPath $ollamaExe) {
        $originalCuda = $env:CUDA_VISIBLE_DEVICES
        if ([string]::IsNullOrWhiteSpace($env:CUDA_VISIBLE_DEVICES)) {
            try {
                $bestGpu = nvidia-smi --query-gpu=index,memory.free,utilization.gpu,uuid --format=csv,noheader,nounits 2>$null |
                    ConvertFrom-Csv -Header "index","free","utilization","uuid" |
                    Sort-Object @{ Expression = { [int]$_.free }; Descending = $true }, @{ Expression = { [int]$_.utilization }; Descending = $false } |
                    Select-Object -First 1
                if ($bestGpu) {
                    $env:CUDA_VISIBLE_DEVICES = $bestGpu.index.ToString().Trim()
                    Write-Host "Selected GPU index $($bestGpu.index.Trim()) UUID $($bestGpu.uuid.Trim()) free $($bestGpu.free.Trim()) MiB utilization $($bestGpu.utilization.Trim())%."
                }
            } catch {
                # Rely on default system GPU routing if nvidia-smi is unavailable
            }
        }

        Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden
        Start-Sleep -Seconds 5

        if ($null -ne $originalCuda) {
            $env:CUDA_VISIBLE_DEVICES = $originalCuda
        }
        else {
            Remove-Item Env:\CUDA_VISIBLE_DEVICES -ErrorAction SilentlyContinue
        }
    }
    else {
        throw "Ollama executable not found at $ollamaExe or in system PATH."
    }
}

function Test-OllamaModelLoaded {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,

        [Parameter(Mandatory = $true)]
        [string]$ModelName
    )

    try {
        $processState = Invoke-RestMethod -Uri "$($Endpoint.TrimEnd('/'))/api/ps" -Method Get -TimeoutSec 3 -ErrorAction Stop
        foreach ($loadedModel in @($processState.models)) {
            $reportedNames = @()
            if ($loadedModel.PSObject.Properties.Name -contains "name") {
                $reportedNames += [string]$loadedModel.name
            }
            if ($loadedModel.PSObject.Properties.Name -contains "model") {
                $reportedNames += [string]$loadedModel.model
            }
            if ($reportedNames -contains $ModelName) {
                return $true
            }
        }
        return $false
    }
    catch {
        # Older or non-Ollama-compatible endpoints may not expose /api/ps.
        # Unknown state is treated as a cold load so the request receives the
        # safer, longer timeout instead of failing early.
        return $null
    }
}

$modelLoaded = Test-OllamaModelLoaded -Endpoint $ollamaUrl -ModelName $Model
$effectiveTimeoutSeconds = $TimeoutSeconds
if ($modelLoaded -ne $true) {
    $effectiveTimeoutSeconds = [math]::Max($TimeoutSeconds, $ColdLoadTimeoutSeconds)
    if ($modelLoaded -eq $false) {
        Write-Host "Ollama model is not currently loaded; allowing up to $effectiveTimeoutSeconds seconds for cold load and generation."
    }
    else {
        Write-Host "Ollama model load state is unavailable; using the cold-load timeout of $effectiveTimeoutSeconds seconds."
    }
}

$startedAt = Get-Date
$localMetricsFile = Join-Path $storagePath "reports\local_llm_metrics.csv"

Write-Host "Sending prompt to Local LLM ($Model)..."
$thinkEnabled = $env:INTEGRATED_POWER_LOCAL_THINKING -eq "1"
$bodyObject = [pscustomobject]@{
    model   = [string]$Model
    prompt  = [string]$prompt
    system  = [string]$SystemPrompt
    stream  = $false
    think   = $thinkEnabled
    keep_alive = [string]$KeepAlive
    options = [pscustomobject]@{
        num_ctx = [int]$NumCtx
    }
}
$body = $bodyObject | ConvertTo-Json -Depth 10

try {
    $tempJsonFile = [System.IO.Path]::GetTempFileName()
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempJsonFile, $body, $utf8NoBom)

    try {
        $curlArguments = @(
            "--silent",
            "--show-error",
            "--connect-timeout", [string]$ConnectTimeoutSeconds,
            "--max-time", [string]$effectiveTimeoutSeconds,
            "--request", "POST",
            "$ollamaUrl/api/generate",
            "--data-binary", "@$tempJsonFile",
            "--header", "Content-Type: application/json"
        )
        $curlOutput = @(& curl.exe @curlArguments 2>&1)
        $curlExitCode = $LASTEXITCODE
        $responseText = ($curlOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        if ($curlExitCode -ne 0) {
            if ($curlExitCode -eq 28) {
                throw "Ollama generation timed out after $effectiveTimeoutSeconds seconds. This limit already includes cold model loading; increase -ColdLoadTimeoutSeconds or -TimeoutSeconds for this model. $responseText"
            }
            throw "Ollama request failed with curl exit code $curlExitCode. $responseText"
        }
        if ([string]::IsNullOrWhiteSpace($responseText)) {
            throw "Ollama returned an empty response."
        }
        $response = $responseText | ConvertFrom-Json
        if (($response.PSObject.Properties.Name -contains "error") -and -not [string]::IsNullOrWhiteSpace([string]$response.error)) {
            throw "Ollama returned an error: $($response.error)"
        }
    }
    finally {
        Remove-Item $tempJsonFile -ErrorAction SilentlyContinue
    }

    $endedAt = Get-Date
    $elapsed = ($endedAt - $startedAt).TotalSeconds

    $content = if ($response.response) { [string]$response.response } else { "" }
    if ($content) {
        Write-IntegratedPowerArtifact `
            -Path $outputPath `
            -Content $content `
            -Mode $ArtifactWriteMode `
            -TaskTitle $TaskTitle `
            -Route "local-llm/$Model"
        Write-Host "Output saved to $outputPath"
    }

    # Record Metrics
    $evalCount = if ($response.eval_count) { $response.eval_count } else { 0 }
    $promptEvalCount = if ($response.prompt_eval_count) { $response.prompt_eval_count } else { 0 }
    $totalTokens = $evalCount + $promptEvalCount

    $metricsFile = Join-Path $storagePath "reports\token_usage.csv"
    $metricsDir = Split-Path -Parent $metricsFile
    if (![string]::IsNullOrWhiteSpace($metricsDir)) {
        New-Item -ItemType Directory -Force -Path $metricsDir | Out-Null
    }

    $row = [pscustomobject]@{
        Timestamp             = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Workspace             = if ($repoRoot) { Split-Path -Leaf $repoRoot } else { "Unknown" }
        WorkspacePath         = $repoRoot
        Operation             = "Local-LLM-Inference"
        Method                = "ollama-api"
        Model                 = $Model
        WordCount             = 0
        CharCount             = 0
        Utf8Bytes             = 0
        InputTokens           = $promptEvalCount
        CachedInputTokens     = 0
        OutputTokens          = $evalCount
        ReasoningOutputTokens = 0
        TotalTokens           = $totalTokens
        EstimatedTokens       = $totalTokens
        Confidence            = "exact"
        Source                = $outputPath
    }

    Write-CsvRowWithRetry -Path $metricsFile -Row $row

    $success = ($content.Length -ge $MinOutputChars)
    if ($success -and ![string]::IsNullOrWhiteSpace($SuccessRegex)) {
        $success = $content -match $SuccessRegex
    }
    Write-LocalLlmMetric -MetricsPath $localMetricsFile -ElapsedSeconds $elapsed -TotalTokens $totalTokens -Content $content -Success $success

    Write-Host "Local LLM ($Model) completed in $([math]::Round($elapsed, 2))s. Total Tokens: $totalTokens"

}
catch {
    $endedAt = Get-Date
    $elapsed = ($endedAt - $startedAt).TotalSeconds
    try {
        Write-LocalLlmMetric -MetricsPath $localMetricsFile -ElapsedSeconds $elapsed -TotalTokens 0 -Content "" -Success $false -ErrorMessage ($_.Exception.Message)
    }
    catch {
        Write-Warning "Failed to record local LLM failure metric: $($_.Exception.Message)"
    }
    Write-Error "Local LLM inference failed: $_"
    exit 1
}



