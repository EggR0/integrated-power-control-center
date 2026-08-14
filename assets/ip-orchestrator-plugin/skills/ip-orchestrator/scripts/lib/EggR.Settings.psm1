Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-EggROrchestratorSettingsPath {
    if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS)) {
        return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS))
    }
    $userProfile = [Environment]::GetFolderPath("UserProfile")
    $preferred = Join-Path $userProfile ".config\integrated-power\orchestrator.json"
    if (Test-Path -LiteralPath $preferred -PathType Leaf) {
        return $preferred
    }
    $previous = Join-Path $userProfile ".config\eggr\orchestrator.json"
    if (Test-Path -LiteralPath $previous -PathType Leaf) {
        return $previous
    }
    $legacy = Join-Path $userProfile ".gemini\config\codex_plugin_settings.json"
    if (Test-Path -LiteralPath $legacy -PathType Leaf) {
        return $legacy
    }
    return $preferred
}

function Get-EggROrchestratorSettings {
    $settingsPath = Get-EggROrchestratorSettingsPath
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        return [pscustomobject]@{
            Exists = $false
            Path = $settingsPath
            CodexExe = $null
            EnabledRoutes = @()
            DefaultRoute = "main_agent"
            LocalLlm = $null
        }
    }

    try {
        $raw = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Integrated Power orchestrator settings are invalid: $settingsPath. $($_.Exception.Message)"
    }

    $routes = @()
    if ($raw.PSObject.Properties.Name -contains "EnabledRoutes") {
        $routes = @($raw.EnabledRoutes | ForEach-Object { [string]$_ })
    }
    $localLlm = if (($raw.PSObject.Properties.Name -contains "LocalLlm") -and $null -ne $raw.LocalLlm) {
        $hardwarePolicy = if (($raw.LocalLlm.PSObject.Properties.Name -contains "HardwarePolicy") -and $null -ne $raw.LocalLlm.HardwarePolicy) {
            [pscustomobject]@{
                Mode = if ($raw.LocalLlm.HardwarePolicy.PSObject.Properties.Name -contains "Mode") { [string]$raw.LocalLlm.HardwarePolicy.Mode } else { "auto" }
                ReserveVramGB = if ($raw.LocalLlm.HardwarePolicy.PSObject.Properties.Name -contains "ReserveVramGB") { [double]$raw.LocalLlm.HardwarePolicy.ReserveVramGB } else { 2.0 }
                AllowCpuOffload = ($raw.LocalLlm.HardwarePolicy.PSObject.Properties.Name -contains "AllowCpuOffload") -and [bool]$raw.LocalLlm.HardwarePolicy.AllowCpuOffload
            }
        } else {
            [pscustomobject]@{
                Mode = if (($raw.LocalLlm.PSObject.Properties.Name -contains "Model") -and -not [string]::IsNullOrWhiteSpace([string]$raw.LocalLlm.Model)) { "user_default" } else { "auto" }
                ReserveVramGB = 2.0
                AllowCpuOffload = $false
            }
        }
        [pscustomobject]@{
            Provider = if ($raw.LocalLlm.PSObject.Properties.Name -contains "Provider") { [string]$raw.LocalLlm.Provider } else { "" }
            Endpoint = if ($raw.LocalLlm.PSObject.Properties.Name -contains "Endpoint") { [string]$raw.LocalLlm.Endpoint } else { "" }
            Model = if ($raw.LocalLlm.PSObject.Properties.Name -contains "Model") { [string]$raw.LocalLlm.Model } else { "" }
            HardwarePolicy = $hardwarePolicy
        }
    } else { $null }
    [pscustomobject]@{
        Exists = $true
        Path = $settingsPath
        CodexExe = if ($raw.PSObject.Properties.Name -contains "CodexExe") { [string]$raw.CodexExe } else { $null }
        EnabledRoutes = $routes
        DefaultRoute = if ($raw.PSObject.Properties.Name -contains "DefaultRoute") { [string]$raw.DefaultRoute } else { "main_agent" }
        LocalLlm = $localLlm
    }
}

function Test-EggRRouteEnabled {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Route,
        [pscustomobject]$Settings = (Get-EggROrchestratorSettings)
    )
    if (-not $Settings.Exists -or @($Settings.EnabledRoutes).Count -eq 0) {
        return $true
    }
    return @($Settings.EnabledRoutes) -contains $Route
}

Export-ModuleMember -Function Get-EggROrchestratorSettingsPath, Get-EggROrchestratorSettings, Test-EggRRouteEnabled
