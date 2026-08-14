[CmdletBinding()]
param(
    [string]$RequestedCodexExe = "",
    [string[]]$EnabledRoutes = @("main_agent", "codex"),
    [ValidateSet("main_agent", "codex", "local_llm")]
    [string]$DefaultRoute = "main_agent",
    [ValidateSet("", "ollama", "vllm")]
    [string]$LocalLlmProvider = "",
    [string]$LocalLlmEndpoint = "",
    [string]$LocalLlmModel = "",
    [ValidateSet("auto", "user_default")]
    [string]$LocalLlmSelectionMode = "auto",
    [ValidateRange(0, 256)]
    [double]$ReserveVramGB = 2,
    [switch]$AllowCpuOffload,
    [string]$SettingsPath = "",
    [switch]$NonInteractive,
    [switch]$PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Integrated Orchestrator First-Run Setup" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$userProfile = [Environment]::GetFolderPath("UserProfile")
$configPath = if (-not [string]::IsNullOrWhiteSpace($SettingsPath)) {
    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($SettingsPath))
} elseif (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS)) {
    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS))
} else {
    Join-Path $userProfile ".config\integrated-power\orchestrator.json"
}
$configDirectory = Split-Path -Parent $configPath

function Test-CodexCandidate {
    param([string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }

    $expanded = [Environment]::ExpandEnvironmentVariables($Candidate.Trim('"'))
    if ([IO.Path]::IsPathRooted($expanded)) {
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            return (Resolve-Path -LiteralPath $expanded).Path
        }
        return $null
    }
    $command = Get-Command -Name $expanded -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Resolve-CodexExe {
    param([string]$Requested)

    foreach ($candidate in @($Requested, $env:CODEX_EXE, "codex.exe", "codex")) {
        $resolved = Test-CodexCandidate -Candidate $candidate
        if ($resolved) { return $resolved }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $codexBin = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
        if (Test-Path -LiteralPath $codexBin -PathType Container) {
            $newest = Get-ChildItem -LiteralPath $codexBin -Filter "codex.exe" -File -Recurse -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if ($newest) { return $newest.FullName }
        }
    }
    return $null
}

function Test-HttpEndpoint {
    param([string]$Endpoint)
    try {
        $uri = [Uri]$Endpoint
        return $uri.IsAbsoluteUri -and $uri.Scheme -in @("http", "https") -and [string]::IsNullOrWhiteSpace($uri.UserInfo)
    } catch {
        return $false
    }
}

function Get-NvidiaSummary {
    $nvidia = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue
    if (-not $nvidia) { return "NVIDIA GPU not detected; the backend will check again at execution time." }
    try {
        $rows = @(& $nvidia.Source "--query-gpu=name,memory.total,memory.free,compute_cap" "--format=csv,noheader,nounits" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $rows.Count -gt 0) {
            return ($rows -join " | ")
        }
        $rows = @(& $nvidia.Source "--query-gpu=name,memory.total,memory.free" "--format=csv,noheader,nounits" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $rows.Count -gt 0) {
            return ($rows -join " | ")
        }
    } catch {
        # Hardware discovery is advisory; the runtime selector retries it.
    }
    return "NVIDIA GPU query unavailable; the backend will check again at execution time."
}

$existing = [ordered]@{}
$readConfigPath = $configPath
$previousConfigPath = if (-not [string]::IsNullOrWhiteSpace($env:EGGR_ORCHESTRATOR_SETTINGS)) {
    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:EGGR_ORCHESTRATOR_SETTINGS))
} else {
    Join-Path $userProfile ".config\eggr\orchestrator.json"
}
$legacyConfigPath = Join-Path $userProfile ".gemini\config\codex_plugin_settings.json"
if (-not (Test-Path -LiteralPath $readConfigPath -PathType Leaf) -and
    (Test-Path -LiteralPath $previousConfigPath -PathType Leaf)) {
    $readConfigPath = $previousConfigPath
} elseif (-not (Test-Path -LiteralPath $readConfigPath -PathType Leaf) -and
    (Test-Path -LiteralPath $legacyConfigPath -PathType Leaf)) {
    $readConfigPath = $legacyConfigPath
}
if (Test-Path -LiteralPath $readConfigPath -PathType Leaf) {
    try {
        $raw = Get-Content -LiteralPath $readConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($property in $raw.PSObject.Properties) {
            $existing[$property.Name] = $property.Value
        }
    } catch {
        throw "Existing orchestrator settings are invalid: $readConfigPath"
    }
}

function Get-ObjectPropertyValue {
    param(
        [AllowNull()][object]$Object,
        [string]$Name,
        [AllowNull()][object]$Default = $null
    )
    if ($null -eq $Object) { return $Default }
    if ($Object -is [Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    if ($Object.PSObject.Properties.Name -contains $Name) {
        return $Object.$Name
    }
    return $Default
}

$existingLocalLlm = Get-ObjectPropertyValue -Object $existing -Name "LocalLlm"
$existingPolicy = Get-ObjectPropertyValue -Object $existingLocalLlm -Name "HardwarePolicy"
if ($NonInteractive) {
    if (-not $PSBoundParameters.ContainsKey("EnabledRoutes")) {
        $savedRoutes = @(Get-ObjectPropertyValue -Object $existing -Name "EnabledRoutes" -Default @())
        if ($savedRoutes.Count -gt 0) { $EnabledRoutes = $savedRoutes }
    }
    if (-not $PSBoundParameters.ContainsKey("DefaultRoute")) {
        $savedDefaultRoute = [string](Get-ObjectPropertyValue -Object $existing -Name "DefaultRoute" -Default "")
        if ($savedDefaultRoute -in @("main_agent", "codex", "local_llm")) {
            $DefaultRoute = $savedDefaultRoute
        }
    }
    if (-not $PSBoundParameters.ContainsKey("LocalLlmProvider")) {
        $LocalLlmProvider = [string](Get-ObjectPropertyValue -Object $existingLocalLlm -Name "Provider" -Default "")
        if ([string]::IsNullOrWhiteSpace($LocalLlmProvider)) {
            $savedEndpoint = [string](Get-ObjectPropertyValue -Object $existingLocalLlm -Name "Endpoint" -Default "")
            if ($savedEndpoint -match ":11434(?:/|$)") { $LocalLlmProvider = "ollama" }
            elseif (-not [string]::IsNullOrWhiteSpace($savedEndpoint)) { $LocalLlmProvider = "vllm" }
        }
    }
    if (-not $PSBoundParameters.ContainsKey("LocalLlmEndpoint")) {
        $LocalLlmEndpoint = [string](Get-ObjectPropertyValue -Object $existingLocalLlm -Name "Endpoint" -Default "")
    }
    if (-not $PSBoundParameters.ContainsKey("LocalLlmModel")) {
        $LocalLlmModel = [string](Get-ObjectPropertyValue -Object $existingLocalLlm -Name "Model" -Default "")
    }
    if (-not $PSBoundParameters.ContainsKey("LocalLlmSelectionMode")) {
        $savedMode = [string](Get-ObjectPropertyValue -Object $existingPolicy -Name "Mode" -Default "")
        if ($savedMode -in @("auto", "user_default")) {
            $LocalLlmSelectionMode = $savedMode
        } elseif (-not [string]::IsNullOrWhiteSpace($LocalLlmModel)) {
            $LocalLlmSelectionMode = "user_default"
        }
    }
    if (-not $PSBoundParameters.ContainsKey("ReserveVramGB")) {
        $savedReserve = Get-ObjectPropertyValue -Object $existingPolicy -Name "ReserveVramGB"
        if ($null -ne $savedReserve) { $ReserveVramGB = [double]$savedReserve }
    }
    if (-not $PSBoundParameters.ContainsKey("AllowCpuOffload")) {
        $AllowCpuOffload = [bool](Get-ObjectPropertyValue -Object $existingPolicy -Name "AllowCpuOffload" -Default $false)
    }
    if ($null -ne $existingLocalLlm -and $LocalLlmProvider -in @("ollama", "vllm") -and $EnabledRoutes -notcontains "local_llm") {
        $EnabledRoutes += "local_llm"
    }
}

if (-not $NonInteractive) {
    $useCodex = Read-Host "Enable Codex delegation? [Y/n]"
    $EnabledRoutes = @("main_agent")
    if ($useCodex -notmatch "^(n|no)$") {
        $EnabledRoutes += "codex"
    }
    $providerInput = (Read-Host "Local LLM provider [none/ollama/vllm]").Trim().ToLowerInvariant()
    if ($providerInput -in @("ollama", "vllm")) {
        $LocalLlmProvider = $providerInput
        $EnabledRoutes += "local_llm"
        $defaultEndpoint = if ($providerInput -eq "ollama") { "http://127.0.0.1:11434" } else { "http://127.0.0.1:8000/v1" }
        $endpointInput = Read-Host "Local LLM endpoint [$defaultEndpoint]"
        $LocalLlmEndpoint = if ([string]::IsNullOrWhiteSpace($endpointInput)) { $defaultEndpoint } else { $endpointInput.Trim() }
        $selectionInput = (Read-Host "Model selection [auto/user_default] (default: auto)").Trim().ToLowerInvariant()
        if ($selectionInput -in @("auto", "user_default")) {
            $LocalLlmSelectionMode = $selectionInput
        }
        if ($LocalLlmSelectionMode -eq "user_default") {
            $LocalLlmModel = (Read-Host "Required local model ID").Trim()
        }
        $reserveInput = (Read-Host "Reserve GPU memory in GB [2]").Trim()
        if (-not [string]::IsNullOrWhiteSpace($reserveInput)) {
            $parsedReserve = 0.0
            if (-not [double]::TryParse($reserveInput, [ref]$parsedReserve) -or $parsedReserve -lt 0 -or $parsedReserve -gt 256) {
                throw "ReserveVramGB must be between 0 and 256."
            }
            $ReserveVramGB = $parsedReserve
        }
        $offloadInput = (Read-Host "Allow CPU offload fallback? [y/N]").Trim()
        $AllowCpuOffload = $offloadInput -match "^(y|yes)$"
        Write-Host ("Detected hardware: " + (Get-NvidiaSummary)) -ForegroundColor DarkCyan
    }
    $routeInput = (Read-Host "Default route [main_agent/codex/local_llm] (default: main_agent)").Trim()
    if (-not [string]::IsNullOrWhiteSpace($routeInput)) {
        $DefaultRoute = $routeInput
    }
}

$EnabledRoutes = @($EnabledRoutes | Where-Object { $_ -in @("main_agent", "codex", "local_llm") } | Select-Object -Unique)
if ($EnabledRoutes -notcontains "main_agent") { $EnabledRoutes = @("main_agent") + $EnabledRoutes }
if ($DefaultRoute -notin $EnabledRoutes) {
    throw "DefaultRoute '$DefaultRoute' is not enabled."
}

$codexExe = $null
if ($EnabledRoutes -contains "codex") {
    $existingCodex = if ($existing.Contains("CodexExe")) { [string]$existing["CodexExe"] } else { "" }
    $requestedCodexCandidate = if ($RequestedCodexExe) { $RequestedCodexExe } else { $existingCodex }
    $codexExe = Resolve-CodexExe -Requested $requestedCodexCandidate
    while (-not $codexExe -and -not $NonInteractive) {
        $candidate = Read-Host "Codex was not found. Enter the full path to codex.exe"
        $codexExe = Test-CodexCandidate -Candidate $candidate
    }
    if (-not $codexExe) {
        throw "Codex delegation is enabled but codex.exe could not be resolved."
    }
}

$localLlm = $existingLocalLlm
if ($EnabledRoutes -contains "local_llm") {
    if ([string]::IsNullOrWhiteSpace($LocalLlmProvider)) {
        throw "local_llm is enabled but LocalLlmProvider is missing."
    }
    if ([string]::IsNullOrWhiteSpace($LocalLlmEndpoint)) {
        $LocalLlmEndpoint = if ($LocalLlmProvider -eq "ollama") { "http://127.0.0.1:11434" } else { "http://127.0.0.1:8000/v1" }
    }
    if (-not (Test-HttpEndpoint -Endpoint $LocalLlmEndpoint)) {
        throw "LocalLlmEndpoint must be an HTTP(S) URL without embedded credentials."
    }
    if ($LocalLlmSelectionMode -eq "user_default" -and [string]::IsNullOrWhiteSpace($LocalLlmModel)) {
        throw "LocalLlmModel is required when LocalLlmSelectionMode is user_default."
    }
    $normalizedLocalLlm = [ordered]@{}
    if ($null -ne $existingLocalLlm) {
        foreach ($property in $existingLocalLlm.PSObject.Properties) {
            $normalizedLocalLlm[$property.Name] = $property.Value
        }
    }
    $normalizedLocalLlm["Provider"] = $LocalLlmProvider
    $normalizedLocalLlm["Endpoint"] = $LocalLlmEndpoint.TrimEnd("/")
    $normalizedLocalLlm["Model"] = if ($LocalLlmSelectionMode -eq "user_default") { $LocalLlmModel } else { $null }
    $normalizedLocalLlm["HardwarePolicy"] = [ordered]@{
            Mode = $LocalLlmSelectionMode
            ReserveVramGB = $ReserveVramGB
            AllowCpuOffload = [bool]$AllowCpuOffload
    }
    if ($LocalLlmProvider -eq "vllm") {
        $normalizedLocalLlm["ApiKeyEnvironmentVariable"] = "VLLM_API_KEY"
    }
    $localLlm = $normalizedLocalLlm
}

$existing["SchemaVersion"] = 2
$existing["CodexExe"] = $codexExe
$existing["EnabledRoutes"] = $EnabledRoutes
$existing["DefaultRoute"] = $DefaultRoute
$existing["LocalLlm"] = $localLlm
$existing["FirstRunCompletedAt"] = [DateTimeOffset]::UtcNow.ToString("o")
$existing["ConfiguredBy"] = "ip-orchestrator-standalone/3.3.0"

New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
$temporary = Join-Path $configDirectory ("orchestrator.{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
try {
    $json = $existing | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporary, "$json`n", (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $configPath -Force
} finally {
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Force
    }
}

$inventoryResult = $null
if ($EnabledRoutes -contains "local_llm" -and $LocalLlmProvider -eq "ollama") {
    $pluginRoot = Split-Path -Parent $PSScriptRoot
    $inventoryScript = Join-Path $pluginRoot "skills\ip-orchestrator\scripts\Sync-OllamaModelRegistry.ps1"
    $bundledRegistry = Join-Path $pluginRoot "skills\ip-orchestrator\references\local_llm_model_registry.csv"
    if (Test-Path -LiteralPath $inventoryScript -PathType Leaf) {
        $inventoryJson = & $inventoryScript `
            -SettingsPath $configPath `
            -RegistryPath (Join-Path $configDirectory "local_llm_model_registry.csv") `
            -BundledRegistryPath $bundledRegistry `
            -OllamaEndpoint $LocalLlmEndpoint `
            -AsJson
        $inventoryResult = $inventoryJson | ConvertFrom-Json
    }
}

Write-Host ""
Write-Host "Integrated Orchestrator settings saved: $configPath" -ForegroundColor Cyan
if ($readConfigPath -ne $configPath) {
    Write-Host "Previous settings were preserved and migrated from: $readConfigPath" -ForegroundColor DarkCyan
}
Write-Host "Enabled routes: $($EnabledRoutes -join ', ')" -ForegroundColor Green
Write-Host "Default route: $DefaultRoute" -ForegroundColor Green
if ($null -ne $inventoryResult) {
    Write-Host ("Ollama inventory: {0} installed, {1} newly registered, {2} registered but not installed." -f `
        @($inventoryResult.InstalledModels).Count,
        @($inventoryResult.NewlyRegistered).Count,
        @($inventoryResult.RegistryModelsNotInstalled).Count) -ForegroundColor DarkCyan
    if (-not [string]::IsNullOrWhiteSpace([string]$inventoryResult.AgentPrompt)) {
        Write-Host ([string]$inventoryResult.AgentPrompt) -ForegroundColor DarkCyan
    }
}

if ($PassThru) {
    Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
