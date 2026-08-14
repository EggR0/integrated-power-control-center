[CmdletBinding()]
param(
    [string]$SettingsPath = "",
    [string]$RegistryPath = "",
    [string]$BundledRegistryPath = "",
    [string]$OllamaEndpoint = "",
    [string[]]$InstalledModels = @(),
    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

function Get-PropertyValue {
    param([object]$Object, [string]$Name, [object]$Fallback = $null)
    if ($null -ne $Object) {
        $property = $Object.PSObject.Properties[$Name]
        if ($null -ne $property) { return $property.Value }
    }
    return $Fallback
}

function Get-SettingsDocument {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        $settingsModule = Join-Path $PSScriptRoot "lib\EggR.Settings.psm1"
        if (-not (Test-Path -LiteralPath $settingsModule -PathType Leaf)) {
            return $null
        }
        Import-Module $settingsModule -Force -DisableNameChecking
        $Path = Get-EggROrchestratorSettingsPath
    }
    $Path = [Environment]::ExpandEnvironmentVariables($Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Integrated Power orchestrator settings are invalid: $Path. $($_.Exception.Message)"
    }
}

function ConvertTo-SizeGB {
    param([string]$Text)

    if ($Text -match '(?i)([\d.]+)\s*(GB|MB|KB)') {
        $value = [double]::Parse($matches[1], [Globalization.CultureInfo]::InvariantCulture)
        $converted = switch ($matches[2].ToUpperInvariant()) {
            "GB" { [math]::Round($value, 3) }
            "MB" { [math]::Round($value / 1024.0, 3) }
            "KB" { [math]::Round($value / 1048576.0, 3) }
        }
        return $converted
    }
    return $null
}

function Get-OllamaInventory {
    param([string]$Endpoint)

    try {
        $response = Invoke-RestMethod -Uri "$($Endpoint.TrimEnd('/'))/api/tags" -Method Get -TimeoutSec 3
        $models = @($response.models | ForEach-Object {
            $details = Get-PropertyValue -Object $_ -Name "details" -Fallback $null
            [pscustomobject]@{
                Name = [string]$_.name
                SizeGB = if ($null -ne $_.size) { [math]::Round(([double]$_.size / 1GB), 3) } else { $null }
                Family = [string](Get-PropertyValue -Object $details -Name "family" -Fallback "")
                ParametersB = ([string](Get-PropertyValue -Object $details -Name "parameter_size" -Fallback "")) -replace '(?i)B$', ''
                Quantization = [string](Get-PropertyValue -Object $details -Name "quantization_level" -Fallback "")
            }
        } | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Name) })
        return [pscustomobject]@{ Source = "ollama_api_tags"; Models = $models }
    } catch {
        # The CLI is a compatibility fallback for an Ollama service that is not reachable by HTTP yet.
    }

    $ollama = Get-Command -Name "ollama" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $ollama) {
        return [pscustomobject]@{ Source = "unavailable"; Models = @() }
    }

    foreach ($verb in @("ls", "list")) {
        try {
            $lines = @(& $ollama.Source $verb 2>$null)
            if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) { continue }
            $models = @($lines | Select-Object -Skip 1 | ForEach-Object {
                $line = [string]$_
                if ([string]::IsNullOrWhiteSpace($line)) { return }
                $columns = @($line.Trim() -split '\s{2,}')
                if ($columns.Count -eq 0 -or [string]::IsNullOrWhiteSpace($columns[0])) { return }
                [pscustomobject]@{
                    Name = $columns[0].Trim()
                    SizeGB = ConvertTo-SizeGB -Text $line
                }
            })
            if ($models.Count -gt 0) {
                return [pscustomobject]@{ Source = "ollama_cli_$verb"; Models = $models }
            }
        } catch {
            # Try the next compatible CLI spelling before declaring Ollama unavailable.
        }
    }
    return [pscustomobject]@{ Source = "unavailable"; Models = @() }
}

function Get-ParameterCountFromModelName {
    param([string]$Model)
    if ($Model -match '(?i)(?:^|[-_:])([\d]+(?:\.[\d]+)?)b(?:$|[-_:])') {
        return $matches[1]
    }
    return ""
}

function Get-QuantizationFromModelName {
    param([string]$Model)
    if ($Model -match '(?i)(Q[2-8](?:_[0-9A-Z]+)*|FP16|BF16|FP8|FP4|INT8|INT4|MXFP4)') {
        return $matches[1].ToUpperInvariant()
    }
    return "unknown"
}

function Get-FamilyFromModelName {
    param([string]$Model)
    $leaf = @($Model -split '/')[-1]
    return @($leaf -split ':')[0]
}

function ConvertTo-RegistryRow {
    param(
        [object]$Source,
        [string[]]$Columns
    )
    $values = [ordered]@{}
    foreach ($column in $Columns) {
        $values[$column] = [string](Get-PropertyValue -Object $Source -Name $column -Fallback "")
    }
    return [pscustomobject]$values
}

$settings = Get-SettingsDocument -Path $SettingsPath
$localSettings = Get-PropertyValue -Object $settings -Name "LocalLlm" -Fallback $null
if ([string]::IsNullOrWhiteSpace($OllamaEndpoint)) {
    $OllamaEndpoint = [string](Get-PropertyValue -Object $localSettings -Name "Endpoint" -Fallback "http://127.0.0.1:11434")
}

$skillRoot = Split-Path $PSScriptRoot -Parent
if ([string]::IsNullOrWhiteSpace($BundledRegistryPath)) {
    $BundledRegistryPath = Join-Path $skillRoot "references\local_llm_model_registry.csv"
}
if (-not (Test-Path -LiteralPath $BundledRegistryPath -PathType Leaf)) {
    throw "Bundled local LLM model registry not found: $BundledRegistryPath"
}

$registryWasExplicit = -not [string]::IsNullOrWhiteSpace($RegistryPath)
$userProfile = [Environment]::GetFolderPath("UserProfile")
if (-not $registryWasExplicit) {
    $RegistryPath = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_LOCAL_LLM_REGISTRY)) {
        [Environment]::ExpandEnvironmentVariables($env:INTEGRATED_POWER_LOCAL_LLM_REGISTRY)
    } else {
        Join-Path $userProfile ".config\integrated-power\local_llm_model_registry.csv"
    }
}
$RegistryPath = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($RegistryPath))

$bundledRows = @(Import-Csv -LiteralPath $BundledRegistryPath)
if ($bundledRows.Count -eq 0) { throw "Bundled local LLM model registry is empty: $BundledRegistryPath" }
$columns = @($bundledRows[0].PSObject.Properties.Name)

$inventory = if ($PSBoundParameters.ContainsKey("InstalledModels")) {
    [pscustomobject]@{
        Source = "parameter"
        Models = @($InstalledModels | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
            [pscustomobject]@{ Name = [string]$_; SizeGB = $null }
        })
    }
} else {
    Get-OllamaInventory -Endpoint $OllamaEndpoint
}
$inventoryModels = @($inventory.Models)

$rowsByModel = @{}
$modelOrder = New-Object Collections.Generic.List[string]
foreach ($row in $bundledRows) {
    $model = [string]$row.Model
    if ([string]::IsNullOrWhiteSpace($model)) { continue }
    $key = $model.ToLowerInvariant()
    if (-not $rowsByModel.ContainsKey($key)) { $modelOrder.Add($key) }
    $rowsByModel[$key] = ConvertTo-RegistryRow -Source $row -Columns $columns
}

$overlaySources = @()
if (-not $registryWasExplicit) {
    $previousRegistry = Join-Path $userProfile ".config\eggr\local_llm_model_registry.csv"
    if (Test-Path -LiteralPath $previousRegistry -PathType Leaf) { $overlaySources += $previousRegistry }
}
if (Test-Path -LiteralPath $RegistryPath -PathType Leaf) { $overlaySources += $RegistryPath }
foreach ($sourcePath in @($overlaySources | Select-Object -Unique)) {
    foreach ($row in @(Import-Csv -LiteralPath $sourcePath)) {
        $model = [string](Get-PropertyValue -Object $row -Name "Model" -Fallback "")
        if ([string]::IsNullOrWhiteSpace($model)) { continue }
        $key = $model.ToLowerInvariant()
        if (-not $rowsByModel.ContainsKey($key)) { $modelOrder.Add($key) }
        $rowsByModel[$key] = ConvertTo-RegistryRow -Source $row -Columns $columns
    }
}

$newlyRegistered = @()
foreach ($installed in $inventoryModels) {
    $model = [string]$installed.Name
    $key = $model.ToLowerInvariant()
    $estimatedWeights = if ($null -ne $installed.SizeGB) {
        [string][math]::Round(([double]$installed.SizeGB) * 1.10, 3)
    } else { "" }
    $detectedFamily = [string](Get-PropertyValue -Object $installed -Name "Family" -Fallback "")
    $detectedParameters = [string](Get-PropertyValue -Object $installed -Name "ParametersB" -Fallback "")
    $detectedQuantization = [string](Get-PropertyValue -Object $installed -Name "Quantization" -Fallback "")
    if ($rowsByModel.ContainsKey($key)) {
        $existingRow = $rowsByModel[$key]
        $sourceNote = [string](Get-PropertyValue -Object $existingRow -Name "SourceNote" -Fallback "")
        if ($sourceNote -like "Discovered from *") {
            if (-not [string]::IsNullOrWhiteSpace($detectedFamily)) { $existingRow.Family = $detectedFamily }
            if (-not [string]::IsNullOrWhiteSpace($detectedParameters)) { $existingRow.ParametersB = $detectedParameters }
            if (-not [string]::IsNullOrWhiteSpace($detectedQuantization)) { $existingRow.Quantization = $detectedQuantization }
            if (-not [string]::IsNullOrWhiteSpace($estimatedWeights)) { $existingRow.EstimatedWeightsGB = $estimatedWeights }
            $existingRow.SourceNote = "Discovered from $($inventory.Source); neutral routing scores require observed metrics or curated metadata."
        }
        continue
    }
    $newRow = [pscustomobject]@{
        Model = $model
        Provider = "ollama"
        Family = if (-not [string]::IsNullOrWhiteSpace($detectedFamily)) {
            $detectedFamily
        } else { Get-FamilyFromModelName -Model $model }
        ParametersB = if (-not [string]::IsNullOrWhiteSpace($detectedParameters)) {
            $detectedParameters
        } else { Get-ParameterCountFromModelName -Model $model }
        Quantization = if (-not [string]::IsNullOrWhiteSpace($detectedQuantization)) {
            $detectedQuantization
        } else { Get-QuantizationFromModelName -Model $model }
        EstimatedWeightsGB = $estimatedWeights
        RequiredRuntimePrecision = ""
        PrecisionBackend = ""
        MinimumComputeCapability = ""
        ContextHintTokens = ""
        SummarizationScore = "5"
        ExtractionScore = "5"
        CodingScore = "5"
        ReasoningScore = "5"
        KoreanScore = "5"
        LongContextScore = "5"
        SpeedScore = "5"
        ReliabilityPrior = "0.50"
        PrimaryUse = "locally installed model; capabilities not curated yet"
        SourceUrl = ""
        SourceNote = "Discovered from $($inventory.Source); neutral routing scores require observed metrics or curated metadata."
    }
    $rowsByModel[$key] = ConvertTo-RegistryRow -Source $newRow -Columns $columns
    $modelOrder.Add($key)
    $newlyRegistered += $model
}

$outputRows = @($modelOrder | ForEach-Object { $rowsByModel[$_] })
$registryDirectory = Split-Path $RegistryPath -Parent
if (-not (Test-Path -LiteralPath $registryDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $registryDirectory -Force | Out-Null
}
$csvText = (@($outputRows | ConvertTo-Csv -NoTypeInformation) -join "`r`n") + "`r`n"
$existingText = if (Test-Path -LiteralPath $RegistryPath -PathType Leaf) {
    Get-Content -LiteralPath $RegistryPath -Raw -Encoding UTF8
} else { "" }
if ($existingText -ne $csvText) {
    [IO.File]::WriteAllText($RegistryPath, $csvText, (New-Object Text.UTF8Encoding($false)))
}

$installedNames = @($inventoryModels | ForEach-Object { [string]$_.Name } | Sort-Object -Unique)
$registeredInstalled = @($installedNames | Where-Object { $rowsByModel.ContainsKey($_.ToLowerInvariant()) })
$registryModelsNotInstalled = @($outputRows | ForEach-Object { [string]$_.Model } | Where-Object {
    $installedNames -notcontains $_
} | Sort-Object -Unique)
$result = [pscustomobject]@{
    Status = if ($inventory.Source -eq "unavailable") { "ollama_unavailable" } else { "ready" }
    NeedsUserConfirmation = $false
    AgentPrompt = if ($inventory.Source -eq "unavailable") {
        "Ollama inventory could not be read. Explain that no installation was attempted and ask the user to start or configure Ollama before retrying."
    } else {
        "The installed Ollama inventory is synchronized. RegistryModelsNotInstalled is informational; do not install those models unless a later selection returns SuggestedInstalls and the user confirms."
    }
    RegistryPath = $RegistryPath
    InventorySource = $inventory.Source
    InstalledModels = $installedNames
    RegisteredInstalled = $registeredInstalled
    NewlyRegistered = @($newlyRegistered | Sort-Object -Unique)
    RegistryModelsNotInstalled = $registryModelsNotInstalled
    SuggestedInstalls = @()
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 8
} else {
    $result
}
