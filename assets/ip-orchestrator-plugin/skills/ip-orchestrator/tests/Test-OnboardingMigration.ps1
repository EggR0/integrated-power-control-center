[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

$skillRoot = Split-Path -Parent $PSScriptRoot
$ensureScript = Join-Path $skillRoot "scripts\Ensure-IpOrchestratorSetup.ps1"
$pluginRoot = [IO.Directory]::GetParent($skillRoot).Parent.FullName
$extensionRoot = [IO.Directory]::GetParent($pluginRoot).Parent.FullName
$installerScript = Join-Path $pluginRoot "install\Install-Plugin.ps1"
$knowledgeToolsRoot = Join-Path $extensionRoot "assets\knowledge-tools"
$rootSetter = Join-Path $knowledgeToolsRoot "set-eggr-roots.ps1"
$rootResolver = Join-Path $knowledgeToolsRoot "eggr-roots.ps1"
$knowledgeWizard = Join-Path $knowledgeToolsRoot "initialize-eggr-knowledge.ps1"
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("ip-onboarding-test-{0}" -f [Guid]::NewGuid().ToString("N"))
$legacyPath = Join-Path $scratch "legacy\orchestrator.json"
$canonicalPath = Join-Path $scratch "canonical\orchestrator.json"
$savedCanonicalEnvironment = $env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS
$savedLegacyEnvironment = $env:EGGR_ORCHESTRATOR_SETTINGS
$savedRootsEnvironment = $env:INTEGRATED_POWER_ROOTS_CONFIG

try {
    $rootsConfig = Join-Path $scratch "portable-config\roots.json"
    $portableWorkRoot = Join-Path $scratch "selected-work"
    $portableKnowledge = Join-Path $scratch "selected-knowledge"
    $portablePluginRoot = Join-Path $scratch "selected-antigravity\plugins"
    $portableToolsRoot = Join-Path $scratch "selected-tools"
    $env:INTEGRATED_POWER_ROOTS_CONFIG = $rootsConfig
    & $rootSetter -WorkRoot $portableWorkRoot -Knowledge $portableKnowledge `
        -AntigravityPluginRoot $portablePluginRoot -ToolsRoot $portableToolsRoot `
        -ConfigFileOverride $rootsConfig | Out-Null
    $resolvedRoots = (& $rootResolver -Json | Out-String) | ConvertFrom-Json
    Assert-True ([string]$resolvedRoots.ConfigFile -eq [IO.Path]::GetFullPath($rootsConfig)) "The canonical roots override must be the only write target."
    Assert-True ([string]$resolvedRoots.WorkRoot -eq [IO.Path]::GetFullPath($portableWorkRoot)) "The selected work root must round-trip without discovery."
    Assert-True ([string]$resolvedRoots.Knowledge -eq [IO.Path]::GetFullPath($portableKnowledge)) "The selected Knowledge root must round-trip without discovery."
    Assert-True ([string]$resolvedRoots.AntigravityPluginRoot -eq [IO.Path]::GetFullPath($portablePluginRoot)) "The selected plugin root must round-trip without assuming the user home."
    Assert-True ([string]$resolvedRoots.ToolsRoot -eq [IO.Path]::GetFullPath($portableToolsRoot)) "The selected tools root must round-trip."

    $wizardResult = (& $knowledgeWizard -KnowledgePath $portableKnowledge `
        -WorkRoot $portableWorkRoot -ToolsRoot $portableToolsRoot `
        -AuthorName "Integrated Power Test" -AuthorEmail "integrated-power@example.invalid" `
        -LocalOnly -NonInteractive -Json | Out-String) | ConvertFrom-Json
    Assert-True ([string]$wizardResult.knowledge_path -eq [IO.Path]::GetFullPath($portableKnowledge)) "The Knowledge wizard must use the selected path."
    Assert-True ([string]$wizardResult.work_root -eq [IO.Path]::GetFullPath($portableWorkRoot)) "The Knowledge wizard must preserve the selected work root."
    Assert-True ([string]$wizardResult.tools_root -eq [IO.Path]::GetFullPath($portableToolsRoot)) "The Knowledge wizard must preserve the selected tools root."
    Assert-True (Test-Path -LiteralPath (Join-Path $portableKnowledge ".git") -PathType Container) "The Knowledge repository must be created only at the selected path."

    New-Item -ItemType Directory -Path (Split-Path -Parent $legacyPath) -Force | Out-Null
    $legacyDocument = [ordered]@{
        SchemaVersion = 1
        EnabledRoutes = @("main_agent", "local_llm")
        DefaultRoute = "local_llm"
        LocalLlm = [ordered]@{
            Endpoint = "http://127.0.0.1:11434"
            Model = "gemma4:26b"
            CustomLocalValue = "preserve-local"
        }
        CustomUserValue = "preserve-root"
    }
    $legacyJson = $legacyDocument | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($legacyPath, "$legacyJson`n", (New-Object Text.UTF8Encoding($false)))
    $legacyBefore = Get-Content -LiteralPath $legacyPath -Raw -Encoding UTF8
    $env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS = $canonicalPath
    $env:EGGR_ORCHESTRATOR_SETTINGS = $legacyPath

    & $ensureScript
    Assert-True (Test-Path -LiteralPath $canonicalPath -PathType Leaf) "Ensure must create the canonical settings file."
    $ensured = Get-Content -LiteralPath $canonicalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($ensured.SchemaVersion -eq 2) "Ensure must upgrade SchemaVersion."
    Assert-True ($ensured.LocalLlm.Provider -eq "ollama") "Ensure must infer the Ollama provider."
    Assert-True ($ensured.LocalLlm.HardwarePolicy.Mode -eq "user_default") "A named legacy model must become user_default."
    Assert-True ($ensured.LocalLlm.HardwarePolicy.ReserveVramGB -eq 2) "Ensure must add the default VRAM reserve."
    Assert-True ($ensured.LocalLlm.CustomLocalValue -eq "preserve-local") "Ensure must preserve unknown LocalLlm values."
    Assert-True ($ensured.CustomUserValue -eq "preserve-root") "Ensure must preserve unknown root values."
    Assert-True (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $canonicalPath) "local_llm_model_registry.csv") -PathType Leaf) "Ensure must synchronize the user registry for Ollama."
    Assert-True ((Get-Content -LiteralPath $legacyPath -Raw -Encoding UTF8) -eq $legacyBefore) "Ensure must not alter the legacy source."

    $firstCanonical = Get-Content -LiteralPath $canonicalPath -Raw -Encoding UTF8
    & $ensureScript
    Assert-True ((Get-Content -LiteralPath $canonicalPath -Raw -Encoding UTF8) -eq $firstCanonical) "Ensure must be idempotent after migration."

    Remove-Item -LiteralPath $canonicalPath -Force
    & $installerScript -NonInteractive -SettingsPath $canonicalPath
    $installed = Get-Content -LiteralPath $canonicalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($installed.SchemaVersion -eq 2) "Installer must write SchemaVersion 2."
    Assert-True ($installed.LocalLlm.Provider -eq "ollama") "Installer must preserve/infer the legacy provider."
    Assert-True ($installed.LocalLlm.HardwarePolicy.Mode -eq "user_default") "Installer must supplement HardwarePolicy."
    Assert-True ($installed.LocalLlm.CustomLocalValue -eq "preserve-local") "Installer must preserve LocalLlm user data."
    Assert-True ($installed.CustomUserValue -eq "preserve-root") "Installer must preserve root user data."
    Assert-True ((Get-Content -LiteralPath $legacyPath -Raw -Encoding UTF8) -eq $legacyBefore) "Installer must not alter the legacy source."

    Write-Host "PASS: canonical onboarding migration and normalization" -ForegroundColor Green
} finally {
    if ($null -eq $savedCanonicalEnvironment) { Remove-Item Env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS -ErrorAction SilentlyContinue }
    else { $env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS = $savedCanonicalEnvironment }
    if ($null -eq $savedLegacyEnvironment) { Remove-Item Env:EGGR_ORCHESTRATOR_SETTINGS -ErrorAction SilentlyContinue }
    else { $env:EGGR_ORCHESTRATOR_SETTINGS = $savedLegacyEnvironment }
    if ($null -eq $savedRootsEnvironment) { Remove-Item Env:INTEGRATED_POWER_ROOTS_CONFIG -ErrorAction SilentlyContinue }
    else { $env:INTEGRATED_POWER_ROOTS_CONFIG = $savedRootsEnvironment }
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
