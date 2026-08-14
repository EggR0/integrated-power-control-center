[CmdletBinding()]
param(
    [string]$RequestedCodexExe = "",
    [switch]$PassThru
)

$ErrorActionPreference = "Stop"

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

function Get-InteractiveInstallerPath {
    try {
        if ($PSScriptRoot) {
            $pluginRoot = [IO.Directory]::GetParent($PSScriptRoot).Parent.Parent.FullName
            $candidate = Join-Path $pluginRoot "install\Install-Plugin.ps1"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    } catch { }
    $configuredPluginRoot = $env:INTEGRATED_POWER_ANTIGRAVITY_PLUGIN_ROOT
    if ([string]::IsNullOrWhiteSpace($configuredPluginRoot)) {
        $pathModule = Join-Path $PSScriptRoot "lib\EggR.Paths.psm1"
        if (Test-Path -LiteralPath $pathModule -PathType Leaf) {
            Import-Module $pathModule -Force -DisableNameChecking
            $roots = Get-EggRRootsConfig
            if ($roots.ContainsKey("antigravity_plugin_root")) {
                $configuredPluginRoot = [string]$roots["antigravity_plugin_root"]
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($configuredPluginRoot)) {
        $configuredPluginRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".gemini\config\plugins"
    }
    $configuredPluginRoot = [IO.Path]::GetFullPath(
        [Environment]::ExpandEnvironmentVariables($configuredPluginRoot)
    )
    return Join-Path $configuredPluginRoot "ip-orchestrator-plugin\install\Install-Plugin.ps1"
}

function Get-PropertyValue {
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
    if ($Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
    return $Default
}

function Write-JsonObjectAtomic {
    param([string]$Path, [object]$Value)
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = Join-Path $directory ("orchestrator.{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
    try {
        $json = $Value | ConvertTo-Json -Depth 10
        [IO.File]::WriteAllText($temporary, "$json`n", (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-NormalizedSettings {
    param([object]$Raw)

    $settings = [ordered]@{}
    foreach ($property in $Raw.PSObject.Properties) { $settings[$property.Name] = $property.Value }
    $local = Get-PropertyValue -Object $Raw -Name "LocalLlm"
    if ($null -ne $local) {
        $normalizedLocal = [ordered]@{}
        foreach ($property in $local.PSObject.Properties) { $normalizedLocal[$property.Name] = $property.Value }
        $provider = [string](Get-PropertyValue -Object $local -Name "Provider" -Default "")
        $endpoint = [string](Get-PropertyValue -Object $local -Name "Endpoint" -Default "")
        $model = [string](Get-PropertyValue -Object $local -Name "Model" -Default "")
        if ($provider -notin @("ollama", "vllm")) {
            if ($endpoint -match ":11434(?:/|$)" -or -not [string]::IsNullOrWhiteSpace($model)) {
                $provider = "ollama"
            } elseif (-not [string]::IsNullOrWhiteSpace($endpoint)) {
                $provider = "vllm"
            }
        }
        if ($provider -in @("ollama", "vllm")) {
            if ([string]::IsNullOrWhiteSpace($endpoint)) {
                $endpoint = if ($provider -eq "ollama") { "http://127.0.0.1:11434" } else { "http://127.0.0.1:8000/v1" }
            }
            $policy = Get-PropertyValue -Object $local -Name "HardwarePolicy"
            $mode = [string](Get-PropertyValue -Object $policy -Name "Mode" -Default "")
            if ($mode -notin @("auto", "user_default")) {
                $mode = if ([string]::IsNullOrWhiteSpace($model)) { "auto" } else { "user_default" }
            }
            $reserve = Get-PropertyValue -Object $policy -Name "ReserveVramGB" -Default 2.0
            $parsedReserve = 2.0
            if (-not [double]::TryParse([string]$reserve, [ref]$parsedReserve) -or $parsedReserve -lt 0 -or $parsedReserve -gt 256) {
                $parsedReserve = 2.0
            }
            $normalizedLocal["Provider"] = $provider
            $normalizedLocal["Endpoint"] = $endpoint.TrimEnd("/")
            $normalizedLocal["Model"] = if ([string]::IsNullOrWhiteSpace($model)) { $null } else { $model }
            $normalizedLocal["HardwarePolicy"] = [ordered]@{
                Mode = $mode
                ReserveVramGB = $parsedReserve
                AllowCpuOffload = [bool](Get-PropertyValue -Object $policy -Name "AllowCpuOffload" -Default $false)
            }
            if ($provider -eq "vllm" -and -not $normalizedLocal.Contains("ApiKeyEnvironmentVariable")) {
                $normalizedLocal["ApiKeyEnvironmentVariable"] = "VLLM_API_KEY"
            }
            $settings["LocalLlm"] = $normalizedLocal
        }
    }

    $routes = @(
        @(Get-PropertyValue -Object $Raw -Name "EnabledRoutes" -Default @()) |
            Where-Object { $_ -in @("main_agent", "codex", "local_llm") } |
            Select-Object -Unique
    )
    if ($routes -notcontains "main_agent") { $routes = @("main_agent") + $routes }
    if ($null -ne $settings["LocalLlm"] -and $routes -notcontains "local_llm") { $routes += "local_llm" }
    $settings["EnabledRoutes"] = $routes
    $defaultRoute = [string](Get-PropertyValue -Object $Raw -Name "DefaultRoute" -Default "main_agent")
    $settings["DefaultRoute"] = if ($defaultRoute -in $routes) { $defaultRoute } else { "main_agent" }
    $settings["CodexExe"] = Get-PropertyValue -Object $Raw -Name "CodexExe"
    $settings["SchemaVersion"] = 2
    return [pscustomobject]$settings
}

function Resolve-CodexExeAutomatically {
    param([string]$RequestedCodexExe, [object]$Settings)

    foreach ($candidate in @(
        $RequestedCodexExe,
        [string](Get-PropertyValue -Object $Settings -Name "CodexExe" -Default ""),
        $env:CODEX_EXE,
        "codex.exe",
        "codex"
    )) {
        $resolved = Test-CodexCandidate -Candidate $candidate
        if ($resolved) { return $resolved }
    }
    if ($env:LOCALAPPDATA) {
        foreach ($root in @(
            (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"),
            (Join-Path $env:LOCALAPPDATA "Programs\OpenAI Codex"),
            (Join-Path $env:LOCALAPPDATA "Programs\Codex")
        )) {
            if (!(Test-Path -LiteralPath $root -PathType Container)) { continue }
            $newest = Get-ChildItem -LiteralPath $root -Filter "codex.exe" -File -Recurse -ErrorAction SilentlyContinue |
                Sort-Object -Property LastWriteTime -Descending |
                Select-Object -First 1
            if ($newest) { return $newest.FullName }
        }
    }
    return $null
}

$userProfile = [Environment]::GetFolderPath("UserProfile")
$settingsPath = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS)) {
    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS))
} else {
    Join-Path $userProfile ".config\integrated-power\orchestrator.json"
}
$previousSettingsPath = if (-not [string]::IsNullOrWhiteSpace($env:EGGR_ORCHESTRATOR_SETTINGS)) {
    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:EGGR_ORCHESTRATOR_SETTINGS))
} else {
    Join-Path $userProfile ".config\eggr\orchestrator.json"
}
$legacySettingsPath = Join-Path $userProfile ".gemini\config\codex_plugin_settings.json"
$readPath = @($settingsPath, $previousSettingsPath, $legacySettingsPath) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
$raw = if ($readPath) {
    Get-Content -LiteralPath $readPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    [pscustomobject]@{
        SchemaVersion = 2
        CodexExe = $null
        EnabledRoutes = @("main_agent", "codex")
        DefaultRoute = "main_agent"
        LocalLlm = $null
    }
}
$settings = Get-NormalizedSettings -Raw $raw
$normalizedJson = $settings | ConvertTo-Json -Depth 10 -Compress
$currentJson = if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    try { (Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json) | ConvertTo-Json -Depth 10 -Compress } catch { "" }
} else { "" }
if ($currentJson -ne $normalizedJson) {
    Write-JsonObjectAtomic -Path $settingsPath -Value $settings
}

$enabledRoutes = @($settings.EnabledRoutes)
$codexExe = Resolve-CodexExeAutomatically -RequestedCodexExe $RequestedCodexExe -Settings $settings
if ($enabledRoutes -contains "codex" -and !$codexExe) {
    $installerPath = Get-InteractiveInstallerPath
    throw "Codex delegation is enabled but codex.exe could not be resolved. Run the interactive installer: powershell -NoProfile -ExecutionPolicy Bypass -File `"$installerPath`""
}
if ($codexExe -and [string](Get-PropertyValue -Object $settings -Name "CodexExe" -Default "") -ne $codexExe) {
    $settings.CodexExe = $codexExe
    Write-JsonObjectAtomic -Path $settingsPath -Value $settings
}

$localLlm = Get-PropertyValue -Object $settings -Name "LocalLlm"
$localProvider = [string](Get-PropertyValue -Object $localLlm -Name "Provider" -Default "")
if (($enabledRoutes -contains "local_llm") -and ($localProvider -eq "ollama")) {
    $inventoryScript = Join-Path $PSScriptRoot "Sync-OllamaModelRegistry.ps1"
    $bundledRegistry = Join-Path (Split-Path -Parent $PSScriptRoot) "references\local_llm_model_registry.csv"
    if (Test-Path -LiteralPath $inventoryScript -PathType Leaf) {
        $null = & $inventoryScript `
            -SettingsPath $settingsPath `
            -RegistryPath (Join-Path (Split-Path -Parent $settingsPath) "local_llm_model_registry.csv") `
            -BundledRegistryPath $bundledRegistry `
            -OllamaEndpoint ([string](Get-PropertyValue -Object $localLlm -Name "Endpoint" -Default "http://127.0.0.1:11434")) `
            -AsJson
    }
}

if ($PassThru) { $codexExe }
