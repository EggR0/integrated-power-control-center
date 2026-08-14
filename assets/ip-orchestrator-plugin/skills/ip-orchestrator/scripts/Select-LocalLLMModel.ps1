[CmdletBinding()]
param(
    [ValidateSet("summarization", "extraction", "coding", "reasoning", "korean", "long_context", "routing_review", "general")]
    [string]$TaskType = "general",
    [string]$TaskScale = "Medium",
    [int]$MetricsWindowDays = 30,
    [int]$MaxExpectedSeconds = 0,
    [switch]$InstalledOnly,
    [string]$RegistryFile = "",
    [string]$MetricsFile = "",
    [string]$SettingsPath = "",
    [string]$Provider = "",
    [string]$OllamaEndpoint = "",
    [string]$HardwareMode = "",
    [string]$PreferredModel = "",
    [double]$AvailableVramGB = -1,
    [string]$ComputeCapability = "",
    [double]$ReserveVramGB = -1,
    [bool]$AllowCpuOffload = $false,
    [string[]]$InstalledModels = @(),
    [switch]$DisableHardwareDetection,
    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

function Get-RepoRoot {
    try {
        $gitRoot = (& git rev-parse --show-toplevel 2>$null)
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($gitRoot)) {
            return ($gitRoot | Select-Object -First 1).Trim()
        }
    } catch {}
    return (Get-Location).Path
}

function ConvertTo-Number {
    param([object]$Value, [double]$Fallback = 0.0)
    $parsed = 0.0
    if ([double]::TryParse(
        [string]$Value,
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$parsed
    )) { return $parsed }
    return $Fallback
}

function Get-PropertyValue {
    param([object]$Object, [string]$Name, [object]$Fallback = $null)
    if ($null -ne $Object) {
        $property = $Object.PSObject.Properties[$Name]
        if ($null -ne $property) { return $property.Value }
    }
    return $Fallback
}

function Get-Settings {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        $settingsModule = Join-Path $PSScriptRoot "lib\EggR.Settings.psm1"
        if (Test-Path -LiteralPath $settingsModule -PathType Leaf) {
            Import-Module $settingsModule -Force -DisableNameChecking
            $Path = Get-EggROrchestratorSettingsPath
        } else {
            $userProfile = [Environment]::GetFolderPath("UserProfile")
            $preferredSettings = Join-Path $userProfile ".config\integrated-power\orchestrator.json"
            $previousSettings = Join-Path $userProfile ".config\eggr\orchestrator.json"
            $legacySettings = Join-Path $userProfile ".gemini\config\codex_plugin_settings.json"
            $Path = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS)) {
                $env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS
            } elseif (Test-Path -LiteralPath $preferredSettings -PathType Leaf) {
                $preferredSettings
            } elseif (Test-Path -LiteralPath $previousSettings -PathType Leaf) {
                $previousSettings
            } else {
                $legacySettings
            }
        }
    }
    $Path = [Environment]::ExpandEnvironmentVariables($Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Integrated Power orchestrator settings are invalid: $Path. $($_.Exception.Message)"
    }
}

function Get-NvidiaHardware {
    $rows = @()
    try {
        $lines = @(& nvidia-smi --query-gpu=index,name,memory.total,memory.free,compute_cap,uuid,utilization.gpu --format=csv,noheader,nounits 2>$null)
        if ($LASTEXITCODE -ne 0) { throw "compute_cap query unavailable" }
        foreach ($line in $lines) {
            if ([string]$line -match '^\s*(\d+),\s*(.*),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([^,]+),\s*([\d.]+)\s*$') {
                $rows += [pscustomobject]@{
                    Index = [int]$matches[1]
                    Name = $matches[2].Trim()
                    TotalVramGB = [math]::Round((ConvertTo-Number $matches[3]) / 1024.0, 3)
                    AvailableVramGB = [math]::Round((ConvertTo-Number $matches[4]) / 1024.0, 3)
                    ComputeCapability = $matches[5]
                    Uuid = $matches[6].Trim()
                    UtilizationPercent = ConvertTo-Number $matches[7]
                }
            }
        }
    } catch {
        try {
            $lines = @(& nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits 2>$null)
            foreach ($line in $lines) {
                if ([string]$line -match '^\s*(\d+),\s*(.*),\s*([\d.]+),\s*([\d.]+)\s*$') {
                    $rows += [pscustomobject]@{
                        Index = [int]$matches[1]
                        Name = $matches[2].Trim()
                        TotalVramGB = [math]::Round((ConvertTo-Number $matches[3]) / 1024.0, 3)
                        AvailableVramGB = [math]::Round((ConvertTo-Number $matches[4]) / 1024.0, 3)
                        ComputeCapability = $null
                        Uuid = $null
                        UtilizationPercent = $null
                    }
                }
            }
        } catch {}
    }
    return @($rows | Sort-Object @{ Expression = "AvailableVramGB"; Descending = $true }, @{ Expression = "UtilizationPercent"; Descending = $false })
}

function Get-OllamaModels {
    param([string]$Endpoint)
    try {
        $response = Invoke-RestMethod -Uri "$($Endpoint.TrimEnd('/'))/api/tags" -Method Get -TimeoutSec 3
        return @($response.models | ForEach-Object {
            [pscustomobject]@{
                Name = [string]$_.name
                SizeGB = if ($null -ne $_.size) { [math]::Round(([double]$_.size / 1GB), 3) } else { $null }
            }
        })
    } catch {
        return @()
    }
}

function Get-TaskScore {
    param([pscustomobject]$Row, [string]$Type)
    $column = switch ($Type) {
        "summarization" { "SummarizationScore" }
        "extraction" { "ExtractionScore" }
        "coding" { "CodingScore" }
        "reasoning" { "ReasoningScore" }
        "korean" { "KoreanScore" }
        "long_context" { "LongContextScore" }
        "routing_review" { "ReasoningScore" }
        default { "SummarizationScore" }
    }
    return ConvertTo-Number (Get-PropertyValue $Row $column 5) 5
}

function Normalize-Score {
    param([double]$Value)
    return [math]::Min(1.0, [math]::Max(0.0, $Value / 10.0))
}

function Get-EstimatedWeightsGB {
    param([pscustomobject]$Row, [hashtable]$InstalledSizeByModel)
    $model = [string]$Row.Model
    if ($InstalledSizeByModel.ContainsKey($model) -and $null -ne $InstalledSizeByModel[$model]) {
        return [pscustomobject]@{
            GB = [math]::Round(([double]$InstalledSizeByModel[$model]) * 1.10, 3)
            Source = "ollama_tag_size_plus_10_percent"
        }
    }
    $curated = ConvertTo-Number (Get-PropertyValue $Row "EstimatedWeightsGB" "") -1
    if ($curated -gt 0) {
        return [pscustomobject]@{ GB = $curated; Source = "registry_estimate" }
    }
    $bits = switch -Regex ([string](Get-PropertyValue $Row "Quantization" "")) {
        '(?i)(MXFP4|Q4|INT4)' { 4; break }
        '(?i)Q5' { 5; break }
        '(?i)(FP8|Q8|INT8)' { 8; break }
        '(?i)(BF16|FP16|F16)' { 16; break }
        default { 16 }
    }
    $parameters = ConvertTo-Number (Get-PropertyValue $Row "ParametersB" 0) 0
    return [pscustomobject]@{
        GB = [math]::Round(($parameters * $bits / 8.0) * 1.15, 3)
        Source = "parameter_quantization_estimate"
    }
}

function Get-MinimumComputeCapability {
    param([pscustomobject]$Row)
    $explicit = [string](Get-PropertyValue $Row "MinimumComputeCapability" "")
    if (-not [string]::IsNullOrWhiteSpace($explicit)) { return $explicit }

    # These defaults are deliberately scoped to TensorRT-RTX runtime precision.
    # GGUF Q4/MXFP4 weight formats are not native FP4 execution requirements.
    $backend = [string](Get-PropertyValue $Row "PrecisionBackend" "")
    $precision = [string](Get-PropertyValue $Row "RequiredRuntimePrecision" "")
    if ($backend -ne "tensorrt-rtx") { return "" }
    $required = switch ($precision.ToUpperInvariant()) {
        "FP4" { "12.0" }
        "FP8" { "8.9" }
        "BF16" { "8.6" }
        "INT4" { "8.6" }
        default { "" }
    }
    return $required
}

function Test-ComputeCapability {
    param([string]$Detected, [string]$Required)
    if ([string]::IsNullOrWhiteSpace($Required)) { return $true }
    if ([string]::IsNullOrWhiteSpace($Detected)) { return $null }
    try { return ([version]$Detected -ge [version]$Required) } catch { return $null }
}

$repoRoot = Get-RepoRoot
$pathModule = Join-Path $PSScriptRoot "lib\EggR.Paths.psm1"
if (Test-Path -LiteralPath $pathModule) {
    Import-Module $pathModule -Force -DisableNameChecking
} else {
    Import-Module (Join-Path $repoRoot "scripts\util\GlobalStorage.psm1") -DisableNameChecking
}
$storagePath = Get-GlobalStorage -RepoRoot $repoRoot
$settings = Get-Settings -Path $SettingsPath
$localSettings = if ($null -ne $settings) { Get-PropertyValue $settings "LocalLlm" $null } else { $null }
$policy = Get-PropertyValue $localSettings "HardwarePolicy" $null
if ($null -eq $policy -and $null -ne $settings) {
    $policy = Get-PropertyValue $settings "HardwarePolicy" $null
}
if ([string]::IsNullOrWhiteSpace($Provider)) {
    $Provider = [string](Get-PropertyValue $localSettings "Provider" "")
}

if ([string]::IsNullOrWhiteSpace($HardwareMode)) {
    $HardwareMode = [string](Get-PropertyValue $policy "Mode" "")
    if ([string]::IsNullOrWhiteSpace($HardwareMode)) {
        $configuredModel = [string](Get-PropertyValue $localSettings "Model" "")
        $HardwareMode = if ([string]::IsNullOrWhiteSpace($configuredModel)) { "auto" } else { "user_default" }
    }
}
if ($HardwareMode -notin @("auto", "user_default")) { $HardwareMode = "auto" }
if ([string]::IsNullOrWhiteSpace($PreferredModel)) {
    $PreferredModel = [string](Get-PropertyValue $policy "PreferredModel" "")
    if ([string]::IsNullOrWhiteSpace($PreferredModel)) {
        $PreferredModel = [string](Get-PropertyValue $localSettings "Model" "")
    }
}
if ($ReserveVramGB -lt 0) {
    $ReserveVramGB = ConvertTo-Number (Get-PropertyValue $policy "ReserveVramGB" 2.0) 2.0
}
if (-not $PSBoundParameters.ContainsKey("AllowCpuOffload")) {
    $configuredOffload = Get-PropertyValue $policy "AllowCpuOffload" $null
    if ($null -ne $configuredOffload) { $AllowCpuOffload = [bool]$configuredOffload }
}
if ([string]::IsNullOrWhiteSpace($OllamaEndpoint)) {
    $OllamaEndpoint = [string](Get-PropertyValue $localSettings "Endpoint" "http://127.0.0.1:11434")
}

$detectedHardware = @()
if (-not $DisableHardwareDetection -and ($AvailableVramGB -lt 0 -or [string]::IsNullOrWhiteSpace($ComputeCapability))) {
    $detectedHardware = @(Get-NvidiaHardware)
}
$selectedGpu = if ($detectedHardware.Count -gt 0) { $detectedHardware[0] } else { $null }
if ($AvailableVramGB -lt 0 -and $null -ne $selectedGpu) { $AvailableVramGB = $selectedGpu.AvailableVramGB }
if ([string]::IsNullOrWhiteSpace($ComputeCapability) -and $null -ne $selectedGpu) {
    $ComputeCapability = [string]$selectedGpu.ComputeCapability
}

if ([string]::IsNullOrWhiteSpace($RegistryFile)) {
    $userProfile = [Environment]::GetFolderPath("UserProfile")
    $preferredUserRegistry = Join-Path $userProfile ".config\integrated-power\local_llm_model_registry.csv"
    $previousUserRegistry = Join-Path $userProfile ".config\eggr\local_llm_model_registry.csv"
    $workspaceRegistry = Join-Path $repoRoot "config\local_llm_model_registry.csv"
    $bundledRegistry = Join-Path (Split-Path $PSScriptRoot -Parent) "references\local_llm_model_registry.csv"
    $RegistryFile = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_LOCAL_LLM_REGISTRY)) {
        [Environment]::ExpandEnvironmentVariables($env:INTEGRATED_POWER_LOCAL_LLM_REGISTRY)
    } elseif (Test-Path -LiteralPath $preferredUserRegistry -PathType Leaf) {
        $preferredUserRegistry
    } elseif (Test-Path -LiteralPath $previousUserRegistry -PathType Leaf) {
        $previousUserRegistry
    } elseif (Test-Path -LiteralPath $workspaceRegistry -PathType Leaf) {
        $workspaceRegistry
    } else {
        $bundledRegistry
    }
}
if ([string]::IsNullOrWhiteSpace($MetricsFile)) {
    $MetricsFile = Join-Path $storagePath "reports\local_llm_metrics.csv"
}
if (-not (Test-Path -LiteralPath $RegistryFile -PathType Leaf)) {
    throw "Local LLM model registry not found: $RegistryFile"
}
$registry = @(Import-Csv -LiteralPath $RegistryFile)
if ($registry.Count -eq 0) { throw "Local LLM model registry is empty: $RegistryFile" }

$ollamaModels = if ($PSBoundParameters.ContainsKey("InstalledModels")) {
    @($InstalledModels | ForEach-Object { [pscustomobject]@{ Name = $_; SizeGB = $null } })
} elseif (-not [string]::IsNullOrWhiteSpace($Provider) -and $Provider -ne "ollama") {
    @()
} else {
    @(Get-OllamaModels -Endpoint $OllamaEndpoint)
}
$installedSet = @{}
$installedSizeByModel = @{}
foreach ($entry in $ollamaModels) {
    $installedSet[[string]$entry.Name] = $true
    $installedSizeByModel[[string]$entry.Name] = $entry.SizeGB
}

$cutoff = (Get-Date).AddDays(-1 * [math]::Max($MetricsWindowDays, 1))
$historyByModel = @{}
if (Test-Path -LiteralPath $MetricsFile -PathType Leaf) {
    foreach ($metric in @(Import-Csv -LiteralPath $MetricsFile)) {
        if ([string]::IsNullOrWhiteSpace([string]$metric.Model)) { continue }
        if (-not [string]::IsNullOrWhiteSpace([string]$metric.TaskType) -and $metric.TaskType -ne $TaskType) { continue }
        $timestamp = [datetime]::MinValue
        if (-not [datetime]::TryParse([string]$metric.Timestamp, [ref]$timestamp) -or $timestamp -lt $cutoff) { continue }
        if (-not $historyByModel.ContainsKey($metric.Model)) {
            $historyByModel[$metric.Model] = New-Object Collections.Generic.List[object]
        }
        $historyByModel[$metric.Model].Add($metric)
    }
}

$rejected = @()
$candidates = foreach ($row in $registry) {
    $model = [string]$row.Model
    if (-not [string]::IsNullOrWhiteSpace($Provider) -and [string]$row.Provider -ne $Provider) { continue }
    $installed = $installedSet.ContainsKey($model)

    $minimumCc = Get-MinimumComputeCapability -Row $row
    $computeFit = Test-ComputeCapability -Detected $ComputeCapability -Required $minimumCc
    if ($computeFit -eq $false) {
        $rejected += [pscustomobject]@{ Model = $model; Reason = "compute_capability"; Required = $minimumCc }
        continue
    }

    $estimate = Get-EstimatedWeightsGB -Row $row -InstalledSizeByModel $installedSizeByModel
    $requiredVram = [math]::Round($estimate.GB + $ReserveVramGB, 3)
    $vramKnown = $AvailableVramGB -ge 0
    $vramFit = if ($vramKnown) { $AvailableVramGB -ge $requiredVram } else { $null }
    if ($vramFit -eq $false -and -not $AllowCpuOffload) {
        $rejected += [pscustomobject]@{ Model = $model; Reason = "vram"; Required = $requiredVram }
        continue
    }

    $taskScore = Normalize-Score (Get-TaskScore -Row $row -Type $TaskType)
    $speedScore = Normalize-Score (ConvertTo-Number (Get-PropertyValue $row "SpeedScore" 5) 5)
    $reliabilityPrior = ConvertTo-Number (Get-PropertyValue $row "ReliabilityPrior" 0.6) 0.6
    # Windows PowerShell 5.1 throws "Argument types do not match" when a one-item
    # Generic.List[object] is wrapped directly in @(...). Pipeline enumeration
    # keeps the result an object array for the 0/1/N metric cases.
    $history = if ($historyByModel.ContainsKey($model)) {
        @($historyByModel[$model] | ForEach-Object { $_ })
    } else { @() }
    $historyCount = @($history).Count
    $successRate = $reliabilityPrior
    $avgElapsed = $null
    $tokensPerSecond = 0.0
    if ($historyCount -gt 0) {
        $successRows = @($history | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.Success) })
        if ($successRows.Count -gt 0) {
            $successRate = @($successRows | Where-Object { [string]$_.Success -match "^(true|1|yes)$" }).Count / [double]$successRows.Count
        }
        $elapsedValues = @($history | ForEach-Object {
            $value = ConvertTo-Number $_.ActualElapsedSeconds 0
            if ($value -gt 0) { $value }
        })
        if ($elapsedValues.Count -gt 0) { $avgElapsed = ($elapsedValues | Measure-Object -Average).Average }
        $tpsValues = @($history | ForEach-Object {
            $value = ConvertTo-Number $_.TokensPerSecond 0
            if ($value -gt 0) { $value }
        })
        if ($tpsValues.Count -gt 0) {
            $tokensPerSecond = ($tpsValues | Measure-Object -Average).Average
            $speedScore = [math]::Min(1.0, [math]::Max(0.1, $tokensPerSecond / 40.0))
        }
    }

    $timePenalty = 0.0
    if ($MaxExpectedSeconds -gt 0 -and $null -ne $avgElapsed -and $avgElapsed -gt $MaxExpectedSeconds) {
        $timePenalty = [math]::Min(0.25, (($avgElapsed - $MaxExpectedSeconds) / $MaxExpectedSeconds) * 0.25)
    }
    $installAdjustment = if ($installed) { 0.08 } else { -0.20 }
    $hardwareAdjustment = if ($vramFit -eq $true) {
        0.08
    } elseif ($vramFit -eq $false) {
        -1 * [math]::Min(0.40, (($requiredVram - $AvailableVramGB) / [math]::Max($requiredVram, 1)) * 0.40)
    } else { 0.0 }
    $score = (0.48 * $taskScore) + (0.27 * $successRate) + (0.17 * $speedScore) +
        (0.08 * $reliabilityPrior) + $installAdjustment + $hardwareAdjustment - $timePenalty

    [pscustomobject]@{
        Model = $model
        Provider = [string]$row.Provider
        TaskType = $TaskType
        TaskScale = $TaskScale
        Score = [math]::Round($score, 4)
        Installed = $installed
        TaskScore = [math]::Round($taskScore, 3)
        HistoricalSuccessRate = [math]::Round($successRate, 3)
        HistoricalSamples = $historyCount
        SpeedScore = [math]::Round($speedScore, 3)
        AverageElapsedSeconds = if ($null -ne $avgElapsed) { [math]::Round($avgElapsed, 2) } else { $null }
        AverageTokensPerSecond = if ($tokensPerSecond -gt 0) { [math]::Round($tokensPerSecond, 2) } else { $null }
        ReliabilityPrior = [math]::Round($reliabilityPrior, 3)
        EstimatedWeightsGB = $estimate.GB
        EstimatedVramRequiredGB = $requiredVram
        EstimateSource = $estimate.Source
        AvailableVramGB = if ($vramKnown) { $AvailableVramGB } else { $null }
        VramFit = $vramFit
        CpuOffloadRequired = ($vramFit -eq $false)
        WeightQuantization = [string](Get-PropertyValue $row "Quantization" "")
        RequiredRuntimePrecision = [string](Get-PropertyValue $row "RequiredRuntimePrecision" "")
        PrecisionBackend = [string](Get-PropertyValue $row "PrecisionBackend" "")
        MinimumComputeCapability = if ([string]::IsNullOrWhiteSpace($minimumCc)) { $null } else { $minimumCc }
        ComputeCapabilityFit = $computeFit
        Compatibility = "registry_evaluated"
        PrimaryUse = [string]$row.PrimaryUse
        SourceUrl = [string]$row.SourceUrl
    }
}

$candidates = @($candidates)
if ($HardwareMode -eq "user_default" -and -not [string]::IsNullOrWhiteSpace($PreferredModel) -and
    @($candidates | Where-Object { $_.Model -eq $PreferredModel }).Count -eq 0) {
    $rejectedMatch = @($rejected | Where-Object { $_.Model -eq $PreferredModel } | Select-Object -First 1)
    if ($rejectedMatch.Count -gt 0) {
        throw "Preferred model '$PreferredModel' violates the configured $($rejectedMatch[0].Reason) constraint."
    }
    $customInstalled = $installedSet.ContainsKey($PreferredModel)
    $customWeights = if ($installedSizeByModel.ContainsKey($PreferredModel) -and $null -ne $installedSizeByModel[$PreferredModel]) {
        [math]::Round(([double]$installedSizeByModel[$PreferredModel]) * 1.10, 3)
    } else { $null }
    $customRequired = if ($null -ne $customWeights) { [math]::Round($customWeights + $ReserveVramGB, 3) } else { $null }
    $customVramFit = if ($null -ne $customRequired -and $AvailableVramGB -ge 0) {
        $AvailableVramGB -ge $customRequired
    } else { $null }
    if ($customVramFit -eq $false -and -not $AllowCpuOffload) {
        throw "Preferred model '$PreferredModel' exceeds available VRAM and CPU offload is disabled."
    }
    $candidates += [pscustomobject]@{
        Model = $PreferredModel
        Provider = if ([string]::IsNullOrWhiteSpace($Provider)) { "unknown" } else { $Provider }
        TaskType = $TaskType
        TaskScale = $TaskScale
        Score = $null
        Installed = $customInstalled
        EstimatedWeightsGB = $customWeights
        EstimatedVramRequiredGB = $customRequired
        EstimateSource = if ($null -ne $customWeights) { "ollama_tag_size_plus_10_percent" } else { "unavailable" }
        AvailableVramGB = if ($AvailableVramGB -ge 0) { $AvailableVramGB } else { $null }
        VramFit = $customVramFit
        CpuOffloadRequired = ($customVramFit -eq $false)
        WeightQuantization = ""
        RequiredRuntimePrecision = ""
        PrecisionBackend = ""
        MinimumComputeCapability = $null
        ComputeCapabilityFit = $null
        Compatibility = "unknown_user_default"
        PrimaryUse = "user configured model outside registry"
        SourceUrl = ""
    }
}

$registryModelsNotInstalled = @($registry | Where-Object {
    -not $installedSet.ContainsKey([string]$_.Model)
} | ForEach-Object { [string]$_.Model } | Sort-Object -Unique)
$eligibleCandidates = if ($InstalledOnly) {
    @($candidates | Where-Object { $_.Installed })
} else {
    @($candidates)
}
$ranked = @($eligibleCandidates | Sort-Object -Property Score -Descending)
$preferredUnavailable = $InstalledOnly -and $HardwareMode -eq "user_default" -and
    -not [string]::IsNullOrWhiteSpace($PreferredModel) -and
    @($ranked | Where-Object { $_.Model -eq $PreferredModel }).Count -eq 0
if ($InstalledOnly -and ($ranked.Count -eq 0 -or $preferredUnavailable)) {
    $suggestionPool = if ($preferredUnavailable) {
        @($candidates | Where-Object { -not $_.Installed -and $_.Model -eq $PreferredModel })
    } else {
        @($candidates | Where-Object { -not $_.Installed } | Sort-Object -Property Score -Descending | Select-Object -First 3)
    }
    $suggestedInstalls = @($suggestionPool | ForEach-Object {
        [pscustomobject]@{
            Model = $_.Model
            Provider = $_.Provider
            Score = $_.Score
            EstimatedVramRequiredGB = $_.EstimatedVramRequiredGB
            VramFit = $_.VramFit
            PrimaryUse = $_.PrimaryUse
            ProposedAction = "ollama pull $($_.Model)"
        }
    })
    $confirmationResult = [pscustomobject]@{
        Status = if ($suggestedInstalls.Count -gt 0) { "needs_user_confirmation" } else { "no_compatible_installed_model" }
        SelectedModel = $null
        Provider = if ([string]::IsNullOrWhiteSpace($Provider)) { "ollama" } else { $Provider }
        TaskType = $TaskType
        TaskScale = $TaskScale
        NeedsUserConfirmation = $suggestedInstalls.Count -gt 0
        AgentPrompt = if ($suggestedInstalls.Count -gt 0) {
            "No eligible installed model is available. Ask the user which SuggestedInstalls model may be downloaded. Do not run ollama pull before explicit confirmation."
        } else {
            "No installed or registry model satisfies the current filters. Report the hardware or policy constraint and ask the user how to proceed."
        }
        SuggestedInstalls = $suggestedInstalls
        RegistryModelsNotInstalled = $registryModelsNotInstalled
        RejectedCandidates = $rejected
    }
    if ($AsJson) {
        $confirmationResult | ConvertTo-Json -Depth 10
    } else {
        $confirmationResult
    }
    return
}
if ($ranked.Count -eq 0) {
    throw "No local LLM candidate matched the filters. TaskType=$TaskType Provider=$Provider InstalledOnly=$InstalledOnly rejected=$($rejected.Count)"
}

$selectionBasis = "automatic_score"
$selected = $ranked[0]
if ($HardwareMode -eq "user_default" -and -not [string]::IsNullOrWhiteSpace($PreferredModel)) {
    $preferred = @($ranked | Where-Object { $_.Model -eq $PreferredModel } | Select-Object -First 1)
    if ($preferred.Count -eq 0) { throw "Preferred model '$PreferredModel' is unavailable." }
    $selected = $preferred[0]
    $selectionBasis = "user_default"
}

$reason = if ($selectionBasis -eq "user_default") {
    "Selected user default $($selected.Model). VRAM fit=$($selected.VramFit), estimated requirement=$($selected.EstimatedVramRequiredGB) GB, available=$($selected.AvailableVramGB) GB."
} else {
    "Selected $($selected.Model) for ${TaskType}: score=$($selected.Score), VRAM fit=$($selected.VramFit), estimated requirement=$($selected.EstimatedVramRequiredGB) GB, available=$($selected.AvailableVramGB) GB, compute capability=$ComputeCapability."
}

$result = [pscustomobject]@{
    Status = "ready"
    SelectedModel = $selected.Model
    Provider = $selected.Provider
    TaskType = $TaskType
    TaskScale = $TaskScale
    SelectionBasis = $selectionBasis
    Reason = $reason
    Hardware = [pscustomobject]@{
        Detection = if ($PSBoundParameters.ContainsKey("AvailableVramGB") -or $PSBoundParameters.ContainsKey("ComputeCapability")) { "override" } elseif ($null -ne $selectedGpu) { "nvidia-smi" } else { "unknown" }
        GpuName = if ($null -ne $selectedGpu) { $selectedGpu.Name } else { $null }
        GpuIndex = if ($null -ne $selectedGpu) { $selectedGpu.Index } else { $null }
        GpuUuid = if ($null -ne $selectedGpu) { $selectedGpu.Uuid } else { $null }
        GpuUtilizationPercent = if ($null -ne $selectedGpu) { $selectedGpu.UtilizationPercent } else { $null }
        AvailableVramGB = if ($AvailableVramGB -ge 0) { $AvailableVramGB } else { $null }
        ComputeCapability = if ([string]::IsNullOrWhiteSpace($ComputeCapability)) { $null } else { $ComputeCapability }
        ReserveVramGB = $ReserveVramGB
        AllowCpuOffload = $AllowCpuOffload
    }
    PrecisionRule = "Quantization describes stored weights and is used for memory estimation. Native FP8/FP4 is a hard constraint only when RequiredRuntimePrecision/PrecisionBackend or MinimumComputeCapability explicitly declares it."
    NeedsUserConfirmation = $false
    AgentPrompt = "Use SelectedModel for this local task. No model installation is required."
    SuggestedInstalls = @()
    RegistryModelsNotInstalled = $registryModelsNotInstalled
    Candidates = $ranked
    RejectedCandidates = $rejected
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 10
} else {
    Write-Host $reason
    $ranked | Select-Object Model, Score, Installed, EstimatedVramRequiredGB, AvailableVramGB, VramFit, CpuOffloadRequired, WeightQuantization, PrimaryUse | Format-Table -AutoSize
}
