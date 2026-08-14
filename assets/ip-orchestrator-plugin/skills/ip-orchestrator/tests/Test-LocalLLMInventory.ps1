[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ([string]$Actual -ne [string]$Expected) {
        throw "$Message Expected='$Expected' Actual='$Actual'"
    }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "")
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$skillRoot = Split-Path $PSScriptRoot -Parent
$scriptsRoot = Join-Path $skillRoot "scripts"
$syncScript = Join-Path $scriptsRoot "Sync-OllamaModelRegistry.ps1"
$selectorScript = Join-Path $scriptsRoot "Select-LocalLLMModel.ps1"
$bundledRegistry = Join-Path $skillRoot "references\local_llm_model_registry.csv"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "integrated-power-local-llm-tests-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

try {
    $bundledHashBefore = Get-Sha256Hex -Path $bundledRegistry
    $overlayRegistry = Join-Path $testRoot "overlay\local_llm_model_registry.csv"
    $syncResult = (& $syncScript -RegistryPath $overlayRegistry -BundledRegistryPath $bundledRegistry `
        -InstalledModels @("gemma4:26b", "llama3.1:8b") -AsJson | Out-String) | ConvertFrom-Json

    Assert-Equal $syncResult.Status "ready" "Injected inventory should be ready."
    Assert-Equal $syncResult.InventorySource "parameter" "Injected inventory source should be reported."
    Assert-True (@($syncResult.NewlyRegistered) -contains "gemma4:26b") "Unregistered installed model was not added to the overlay."
    Assert-Equal @($syncResult.SuggestedInstalls).Count 0 "Inventory sync must not suggest or install registry-only models."
    Assert-True (Test-Path -LiteralPath $overlayRegistry -PathType Leaf) "Overlay registry was not created."

    $gemmaRow = @(Import-Csv -LiteralPath $overlayRegistry | Where-Object { $_.Model -eq "gemma4:26b" })
    Assert-Equal $gemmaRow.Count 1 "Discovered model should appear once in the overlay."
    Assert-Equal $gemmaRow[0].ReasoningScore "5" "Discovered model should begin with a neutral score."
    Assert-Equal $gemmaRow[0].ReliabilityPrior "0.50" "Discovered model should begin with a neutral reliability prior."
    Assert-Equal (Get-Sha256Hex -Path $bundledRegistry) $bundledHashBefore "Bundled registry must remain immutable."

    $overlayHashBeforeSecondRun = Get-Sha256Hex -Path $overlayRegistry
    $secondSync = (& $syncScript -RegistryPath $overlayRegistry -BundledRegistryPath $bundledRegistry `
        -InstalledModels @("gemma4:26b", "llama3.1:8b") -AsJson | Out-String) | ConvertFrom-Json
    Assert-Equal @($secondSync.NewlyRegistered).Count 0 "A repeated sync must not re-register an existing model."
    Assert-Equal (Get-Sha256Hex -Path $overlayRegistry) $overlayHashBeforeSecondRun "Repeated sync should be byte-idempotent."

    $settingsFile = Join-Path $testRoot "orchestrator.json"
    [IO.File]::WriteAllText($settingsFile, (@{
        LocalLlm = @{
            Provider = "ollama"
            Endpoint = "http://127.0.0.1:11434"
            Model = "gemma4:26b"
        }
    } | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    $configuredDefault = (& $selectorScript -TaskType general -RegistryFile $overlayRegistry -SettingsPath $settingsFile `
        -MetricsFile (Join-Path $testRoot "no-configured-model-metrics.csv") -InstalledOnly `
        -InstalledModels @("gemma4:26b") -DisableHardwareDetection -AvailableVramGB 100 -ReserveVramGB 0 -AsJson |
        Out-String) | ConvertFrom-Json
    Assert-Equal $configuredDefault.SelectedModel "gemma4:26b" "A configured model without an explicit policy should be treated as the user default."
    Assert-Equal $configuredDefault.SelectionBasis "user_default" "Configured model selection basis should be user_default."

    $singleRegistry = Join-Path $testRoot "single-model-registry.csv"
    @(Import-Csv -LiteralPath $bundledRegistry | Where-Object { $_.Model -eq "llama3.1:8b" }) |
        Export-Csv -LiteralPath $singleRegistry -NoTypeInformation -Encoding UTF8
    $metricsFile = Join-Path $testRoot "local_llm_metrics.csv"
    $emptySettingsFile = Join-Path $testRoot "empty-orchestrator.json"
    [IO.File]::WriteAllText($emptySettingsFile, "{}", (New-Object Text.UTF8Encoding($false)))
    $selectorArguments = @{
        TaskType = "general"
        RegistryFile = $singleRegistry
        MetricsFile = $metricsFile
        SettingsPath = $emptySettingsFile
        InstalledOnly = $true
        InstalledModels = @("llama3.1:8b")
        DisableHardwareDetection = $true
        AvailableVramGB = 100
        ReserveVramGB = 0
        AsJson = $true
    }

    $zeroHistory = (& $selectorScript @selectorArguments | Out-String) | ConvertFrom-Json
    Assert-Equal $zeroHistory.Status "ready" "A registered installed model should be selectable."
    Assert-Equal $zeroHistory.Candidates[0].HistoricalSamples 0 "Missing metrics should yield zero history samples."

    $now = Get-Date
    @([pscustomobject]@{
        Timestamp = $now.ToString("o")
        Model = "llama3.1:8b"
        TaskType = "general"
        Success = "true"
        ActualElapsedSeconds = "10"
        TokensPerSecond = "20"
    }) | Export-Csv -LiteralPath $metricsFile -NoTypeInformation -Encoding UTF8
    $oneHistory = (& $selectorScript @selectorArguments | Out-String) | ConvertFrom-Json
    Assert-Equal $oneHistory.Candidates[0].HistoricalSamples 1 "One metric must remain an array under Windows PowerShell 5.1 strict mode."

    @(1..3 | ForEach-Object {
        [pscustomobject]@{
            Timestamp = $now.AddMinutes($_).ToString("o")
            Model = "llama3.1:8b"
            TaskType = "general"
            Success = "true"
            ActualElapsedSeconds = [string](10 + $_)
            TokensPerSecond = [string](20 + $_)
        }
    }) | Export-Csv -LiteralPath $metricsFile -NoTypeInformation -Encoding UTF8
    $manyHistory = (& $selectorScript @selectorArguments | Out-String) | ConvertFrom-Json
    Assert-Equal $manyHistory.Candidates[0].HistoricalSamples 3 "Multiple metrics should preserve all samples."

    $selectorArguments.InstalledModels = @("not-in-registry:1b")
    $needsConfirmation = (& $selectorScript @selectorArguments | Out-String) | ConvertFrom-Json
    Assert-Equal $needsConfirmation.Status "needs_user_confirmation" "No installed candidate should return a confirmation contract instead of throwing."
    Assert-True ([bool]$needsConfirmation.NeedsUserConfirmation) "A suggested download must require explicit user confirmation."
    Assert-True (@($needsConfirmation.SuggestedInstalls).Count -gt 0) "A compatible registry candidate should be suggested."
    Assert-True ([string]$needsConfirmation.AgentPrompt -match "Do not run ollama pull") "The result must prohibit automatic model installation."

    $previousRegistryOverride = $env:INTEGRATED_POWER_LOCAL_LLM_REGISTRY
    try {
        $env:INTEGRATED_POWER_LOCAL_LLM_REGISTRY = $singleRegistry
        $selectorArguments.Remove("RegistryFile")
        $selectorArguments.InstalledModels = @("llama3.1:8b")
        $fromCentralRegistry = (& $selectorScript @selectorArguments | Out-String) | ConvertFrom-Json
        Assert-Equal $fromCentralRegistry.SelectedModel "llama3.1:8b" "The central registry override should take precedence."
    } finally {
        $env:INTEGRATED_POWER_LOCAL_LLM_REGISTRY = $previousRegistryOverride
    }

    Write-Host "PASS: local LLM inventory/selection tests (sync idempotence, immutable bundled registry, metrics 0/1/N, confirmation contract, central registry)."
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
