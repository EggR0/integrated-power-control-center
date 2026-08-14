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

    [string]$Endpoint = "",

    [string]$Model = "",

    [string]$SystemPrompt = "You are a helpful AI coding assistant.",

    [int]$MaxTokens = 2048,

    [double]$Temperature = 0.2,

    [int]$TimeoutSeconds = 1800,

    [string]$TaskTitle = "vLLM Inference",

    [string]$TaskScale = "Medium",

    [ValidateSet("summarization", "extraction", "coding", "reasoning", "korean", "long_context", "routing_review", "general")]
    [string]$TaskType = "general",

    [string]$SuccessRegex = "",

    [int]$MinOutputChars = 1,

    [string]$SelectedBy = "manual",

    [string]$SelectionReason = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Text
    )

    $dir = Split-Path -Parent $Path
    if (![string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Invoke-CurlJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & curl.exe @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "curl.exe failed with exit code $exitCode`: $output"
    }

    if ([string]::IsNullOrWhiteSpace($output)) {
        throw "curl.exe returned an empty response."
    }

    return ($output | ConvertFrom-Json)
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
        Provider             = if ($Source.Provider) { $Source.Provider } else { "vllm-openai-compatible" }
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
        Provider             = "vllm-openai-compatible"
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

function Get-FirstModelId {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ModelsUrl,

        [string]$ApiKey = ""
    )

    $args = @("-sS", "--max-time", "5", $ModelsUrl)
    if (![string]::IsNullOrWhiteSpace($ApiKey)) {
        $args += @("-H", "Authorization: Bearer $ApiKey")
    }

    try {
        $models = Invoke-CurlJson -Arguments $args
        if ($models.data -and $models.data.Count -gt 0 -and $models.data[0].id) {
            return [string]$models.data[0].id
        }
    }
    catch {
        throw "Unable to auto-detect a vLLM model from $ModelsUrl. Pass -Model explicitly. $($_.Exception.Message)"
    }

    throw "Unable to auto-detect a vLLM model from $ModelsUrl. Pass -Model explicitly."
}

function Resolve-OpenAIBaseUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint
    )

    $baseUrl = $Endpoint.TrimEnd("/")
    if ($baseUrl -notmatch "/v1$") {
        $baseUrl = "$baseUrl/v1"
    }

    return $baseUrl
}

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
Import-Module (Join-Path $PSScriptRoot "lib\EggR.Settings.psm1") -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot "lib\IntegratedPower.Artifacts.psm1") -Force -DisableNameChecking
$storagePath = Get-GlobalStorage -RepoRoot $repoRoot
$orchestratorSettings = Get-EggROrchestratorSettings
if (-not (Test-EggRRouteEnabled -Route "local_llm" -Settings $orchestratorSettings)) {
    throw "The local_llm route is disabled in $($orchestratorSettings.Path)."
}

if ([string]::IsNullOrWhiteSpace($Endpoint)) {
    if (![string]::IsNullOrWhiteSpace($env:VLLM_BASE_URL)) {
        $Endpoint = $env:VLLM_BASE_URL
    }
    elseif (
        $orchestratorSettings.LocalLlm -and
        [string]$orchestratorSettings.LocalLlm.Provider -eq "vllm" -and
        -not [string]::IsNullOrWhiteSpace([string]$orchestratorSettings.LocalLlm.Endpoint)
    ) {
        $Endpoint = [string]$orchestratorSettings.LocalLlm.Endpoint
    }
    else {
        $Endpoint = "http://localhost:8000/v1"
    }
}
if ([string]::IsNullOrWhiteSpace($Model) -and $orchestratorSettings.LocalLlm -and $orchestratorSettings.LocalLlm.PSObject.Properties.Name -contains "Model") {
    $Model = [string]$orchestratorSettings.LocalLlm.Model
}

$baseUrl = Resolve-OpenAIBaseUrl -Endpoint $Endpoint
$modelsUrl = "$baseUrl/models"
$chatUrl = "$baseUrl/chat/completions"
$apiKey = $env:VLLM_API_KEY

if ([string]::IsNullOrWhiteSpace($Model)) {
    $Model = Get-FirstModelId -ModelsUrl $modelsUrl -ApiKey $apiKey
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

$bodyObject = [pscustomobject]@{
    model       = [string]$Model
    messages    = @(
        [pscustomobject]@{
            role    = "system"
            content = [string]$SystemPrompt
        },
        [pscustomobject]@{
            role    = "user"
            content = [string]$prompt
        }
    )
    stream      = $false
    max_tokens  = [int]$MaxTokens
    temperature = [double]$Temperature
}
$body = $bodyObject | ConvertTo-Json -Depth 10

$startedAt = Get-Date
$tempJsonFile = [System.IO.Path]::GetTempFileName()
$localMetricsFile = Join-Path $storagePath "reports\local_llm_metrics.csv"
$requestError = ""
$response = $null

try {
    Write-Utf8NoBom -Path $tempJsonFile -Text $body

    $curlArgs = @(
        "-sS",
        "--max-time", [string]$TimeoutSeconds,
        "-X", "POST",
        $chatUrl,
        "-H", "Content-Type: application/json",
        "-d", "@$tempJsonFile"
    )

    if (![string]::IsNullOrWhiteSpace($apiKey)) {
        $curlArgs += @("-H", "Authorization: Bearer $apiKey")
    }

    Write-Host "Sending prompt to vLLM ($Model) at $chatUrl..."
    $response = Invoke-CurlJson -Arguments $curlArgs
}
catch {
    $requestError = $_.Exception.Message
}
finally {
    Remove-Item -LiteralPath $tempJsonFile -ErrorAction SilentlyContinue
}

if (![string]::IsNullOrWhiteSpace($requestError)) {
    $endedAt = Get-Date
    $elapsed = ($endedAt - $startedAt).TotalSeconds
    try {
        Write-LocalLlmMetric -MetricsPath $localMetricsFile -ElapsedSeconds $elapsed -TotalTokens 0 -Content "" -Success $false -ErrorMessage $requestError
    }
    catch {
        Write-Warning "Failed to record vLLM failure metric: $($_.Exception.Message)"
    }
    Write-Error "vLLM inference failed: $requestError"
    exit 1
}

try {
    $endedAt = Get-Date
    $elapsed = ($endedAt - $startedAt).TotalSeconds

    if ($response.error) {
        $message = if ($response.error.message) { $response.error.message } else { ($response.error | ConvertTo-Json -Depth 10) }
        throw "vLLM returned an error: $message"
    }

    $content = $null
    if ($response.choices -and $response.choices.Count -gt 0) {
        if ($response.choices[0].message -and $null -ne $response.choices[0].message.content) {
            $content = [string]$response.choices[0].message.content
        }
        elseif ($null -ne $response.choices[0].text) {
            $content = [string]$response.choices[0].text
        }
    }

    if ($null -eq $content) {
        throw "vLLM response did not include choices[0].message.content."
    }

    Write-IntegratedPowerArtifact `
        -Path $outputPath `
        -Content $content `
        -Mode $ArtifactWriteMode `
        -TaskTitle $TaskTitle `
        -Route "vllm/$Model"

    $promptTokens = if ($response.usage -and $response.usage.prompt_tokens) { [int]$response.usage.prompt_tokens } else { 0 }
    $completionTokens = if ($response.usage -and $response.usage.completion_tokens) { [int]$response.usage.completion_tokens } else { 0 }
    $totalTokens = if ($response.usage -and $response.usage.total_tokens) { [int]$response.usage.total_tokens } else { $promptTokens + $completionTokens }

    $metricsFile = Join-Path $storagePath "reports\token_usage.csv"
    $metricsDir = Split-Path -Parent $metricsFile
    if (![string]::IsNullOrWhiteSpace($metricsDir)) {
        New-Item -ItemType Directory -Force -Path $metricsDir | Out-Null
    }

    $row = [pscustomobject]@{
        Timestamp             = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Workspace             = if ($repoRoot) { Split-Path -Leaf $repoRoot } else { "Unknown" }
        WorkspacePath         = $repoRoot
        Operation             = "vLLM-Inference"
        Method                = "vllm-openai-compatible"
        Model                 = $Model
        WordCount             = 0
        CharCount             = 0
        Utf8Bytes             = 0
        InputTokens           = $promptTokens
        CachedInputTokens     = 0
        OutputTokens          = $completionTokens
        ReasoningOutputTokens = 0
        TotalTokens           = $totalTokens
        EstimatedTokens       = $totalTokens
        Confidence            = if ($totalTokens -gt 0) { "exact" } else { "unknown" }
        Source                = $outputPath
    }

    Write-CsvRowWithRetry -Path $metricsFile -Row $row

    $success = ($content.Length -ge $MinOutputChars)
    if ($success -and ![string]::IsNullOrWhiteSpace($SuccessRegex)) {
        $success = $content -match $SuccessRegex
    }
    Write-LocalLlmMetric -MetricsPath $localMetricsFile -ElapsedSeconds $elapsed -TotalTokens $totalTokens -Content $content -Success $success

    Write-Host "vLLM final message: $outputPath"
    Write-Host "vLLM ($Model) completed in $([math]::Round($elapsed, 2))s. Total Tokens: $totalTokens"
}
catch {
    $endedAt = Get-Date
    $elapsed = ($endedAt - $startedAt).TotalSeconds
    try {
        Write-LocalLlmMetric -MetricsPath $localMetricsFile -ElapsedSeconds $elapsed -TotalTokens 0 -Content "" -Success $false -ErrorMessage ($_.Exception.Message)
    }
    catch {
        Write-Warning "Failed to record vLLM failure metric: $($_.Exception.Message)"
    }
    Write-Error $_
    exit 1
}
