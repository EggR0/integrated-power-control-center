<#
.SYNOPSIS
    Resolves EggR paths without tying them to one agent product or one machine.
.DESCRIPTION
    Explicit choices always win, even when the selected directory has not been
    created yet. Nothing is moved automatically. Use eggr-doctor.ps1 to detect a
    missing or split layout.
.PARAMETER WorkRoot
    One-run override. This does not change roots.json.
.PARAMETER Property
    Return one property, such as WorkRoot, Knowledge, Worklog, or WorkRootSource.
.PARAMETER Json
    Return the complete result as compact JSON.
#>
[CmdletBinding()]
param(
    [string]$WorkRoot = "",
    [string]$Property = "",
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$userProfile = [Environment]::GetFolderPath('UserProfile')
$documents = [Environment]::GetFolderPath('MyDocuments')
$runningOnWindows = [Environment]::OSVersion.Platform -eq 'Win32NT'
$preferredConfigFile = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ROOTS_CONFIG)) {
    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:INTEGRATED_POWER_ROOTS_CONFIG))
} else {
    Join-Path $userProfile '.config\integrated-power\roots.json'
}
$previousConfigFile = Join-Path $userProfile '.config\eggr\roots.json'
$configFile = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ROOTS_CONFIG)) {
    $preferredConfigFile
} elseif (Test-Path -LiteralPath $preferredConfigFile -PathType Leaf) {
    $preferredConfigFile
} elseif (Test-Path -LiteralPath $previousConfigFile -PathType Leaf) {
    $previousConfigFile
} else {
    $preferredConfigFile
}
$script:resolutionWarnings = @()
$configRoots = @{}

function ConvertTo-EggRAbsolutePath {
    param(
        [string]$PathValue,
        [string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $null
    }

    $expanded = [Environment]::ExpandEnvironmentVariables($PathValue.Trim())
    if ($expanded -eq '~') {
        $expanded = $userProfile
    } elseif ($expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) {
        $expanded = Join-Path $userProfile $expanded.Substring(2)
    }

    if (-not [IO.Path]::IsPathRooted($expanded)) {
        throw "$Label must be an absolute path: $PathValue"
    }

    $fullPath = [IO.Path]::GetFullPath($expanded)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $pathRoot.Length) {
        $fullPath = $fullPath.TrimEnd('\', '/')
    }
    return $fullPath
}

function Test-ContainsCoreRepository {
    param([string]$CandidateRoot)

    foreach ($name in @('environment-bootstrap', 'eggr-environment-bootstrap', 'Knowledge', 'eggr-knowledge', 'dotfiles', 'eggr-dotfiles')) {
        if (Test-Path -LiteralPath (Join-Path $CandidateRoot $name)) {
            return $true
        }
    }
    return $false
}

function Test-PathInsideRoot {
    param(
        [string]$Candidate,
        [string]$Root
    )

    $comparison = if ($runningOnWindows) {
        [StringComparison]::OrdinalIgnoreCase
    } else {
        [StringComparison]::Ordinal
    }
    $normalizedRoot = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $normalizedCandidate = $Candidate.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    return $normalizedCandidate.StartsWith($normalizedRoot, $comparison)
}

function Test-RemoteContainsCredential {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }
    $candidate = $Value.Trim()
    if ($candidate -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        try {
            $uri = [Uri]$candidate
            if ($uri.Scheme -eq 'ssh') {
                return $uri.UserInfo -match ':'
            }
            return -not [string]::IsNullOrWhiteSpace($uri.UserInfo)
        } catch {
            return $false
        }
    }
    return $candidate -match '^(?i)(https?|git)://[^/]*@'
}

if (Test-Path -LiteralPath $configFile -PathType Leaf) {
    try {
        $jsonContent = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
        foreach ($prop in $jsonContent.PSObject.Properties) {
            $configRoots[$prop.Name] = [string]$prop.Value
        }
    } catch {
        $script:resolutionWarnings += "Invalid roots config was ignored: $configFile ($($_.Exception.Message))"
    }
}

$configuredKnowledgeRemote = if ($configRoots.ContainsKey('knowledge_remote')) {
    [string]$configRoots['knowledge_remote']
} else {
    ''
}
if (Test-RemoteContainsCredential -Value $configuredKnowledgeRemote) {
    $script:resolutionWarnings += "Knowledge remote contains embedded credentials and was suppressed: $configFile"
    $configuredKnowledgeRemote = ''
}

$bootstrapSelf = Split-Path -Parent $PSScriptRoot
$bootstrapName = Split-Path -Leaf $bootstrapSelf
$bootstrapParent = Split-Path -Parent $bootstrapSelf
$legacyWindowsRoot = if ($runningOnWindows) { Join-Path $documents 'Codex' } else { $null }

$resolvedWorkRoot = $null
$workRootSource = $null

try {
    if (-not [string]::IsNullOrWhiteSpace($WorkRoot)) {
        $resolvedWorkRoot = ConvertTo-EggRAbsolutePath -PathValue $WorkRoot -Label 'WorkRoot override'
        $workRootSource = 'parameter'
    } elseif (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_WORK_ROOT)) {
        $resolvedWorkRoot = ConvertTo-EggRAbsolutePath -PathValue $env:INTEGRATED_POWER_WORK_ROOT -Label 'INTEGRATED_POWER_WORK_ROOT'
        $workRootSource = 'environment'
    } elseif (-not [string]::IsNullOrWhiteSpace($env:EGGR_WORK_ROOT)) {
        $resolvedWorkRoot = ConvertTo-EggRAbsolutePath -PathValue $env:EGGR_WORK_ROOT -Label 'EGGR_WORK_ROOT'
        $workRootSource = 'environment'
    } elseif ($configRoots.ContainsKey('work_root') -and -not [string]::IsNullOrWhiteSpace($configRoots['work_root'])) {
        $resolvedWorkRoot = ConvertTo-EggRAbsolutePath -PathValue $configRoots['work_root'] -Label 'roots.json work_root'
        $workRootSource = 'config'
    } elseif ($bootstrapName -in @('environment-bootstrap', 'eggr-environment-bootstrap')) {
        $resolvedWorkRoot = ConvertTo-EggRAbsolutePath -PathValue $bootstrapParent -Label 'bootstrap parent'
        $workRootSource = 'bootstrap_parent'
    } elseif ($runningOnWindows -and (Test-Path -LiteralPath $legacyWindowsRoot) -and (Test-ContainsCoreRepository $legacyWindowsRoot)) {
        $resolvedWorkRoot = ConvertTo-EggRAbsolutePath -PathValue $legacyWindowsRoot -Label 'legacy Windows root'
        $workRootSource = 'legacy_detected'
    } elseif ($runningOnWindows) {
        $resolvedWorkRoot = Join-Path $documents 'EggR'
        $workRootSource = 'windows_default'
    } else {
        $resolvedWorkRoot = Join-Path $userProfile 'Workspace'
        $workRootSource = 'unix_default'
    }
} catch {
    throw "EggR work-root resolution failed: $($_.Exception.Message)"
}

function Resolve-EggRRepository {
    param(
        [string]$ConfigName,
        [string[]]$Candidates
    )

    if ($configRoots.ContainsKey($ConfigName) -and -not [string]::IsNullOrWhiteSpace($configRoots[$ConfigName])) {
        return ConvertTo-EggRAbsolutePath -PathValue $configRoots[$ConfigName] -Label "roots.json $ConfigName"
    }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return ConvertTo-EggRAbsolutePath -PathValue $candidate -Label $ConfigName
        }
    }
    return ConvertTo-EggRAbsolutePath -PathValue $Candidates[0] -Label $ConfigName
}

$bootstrapCandidates = @()
if ($bootstrapName -in @('environment-bootstrap', 'eggr-environment-bootstrap')) {
    $bootstrapCandidates += $bootstrapSelf
}
$bootstrapCandidates += @(
    [IO.Path]::Combine($resolvedWorkRoot, 'environment-bootstrap'),
    [IO.Path]::Combine($resolvedWorkRoot, 'eggr-environment-bootstrap')
)
$bootstrap = Resolve-EggRRepository -ConfigName 'bootstrap' -Candidates $bootstrapCandidates
$knowledge = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_KNOWLEDGE_ROOT)) {
    ConvertTo-EggRAbsolutePath -PathValue $env:INTEGRATED_POWER_KNOWLEDGE_ROOT -Label 'INTEGRATED_POWER_KNOWLEDGE_ROOT'
} else {
    Resolve-EggRRepository -ConfigName 'knowledge' -Candidates @(
        ([IO.Path]::Combine($resolvedWorkRoot, 'Knowledge')),
        ([IO.Path]::Combine($resolvedWorkRoot, 'eggr-knowledge')),
        (Join-Path $userProfile 'Knowledge')
    )
}
$dotfiles = Resolve-EggRRepository -ConfigName 'dotfiles' -Candidates @(
    ([IO.Path]::Combine($resolvedWorkRoot, 'dotfiles')),
    ([IO.Path]::Combine($resolvedWorkRoot, 'eggr-dotfiles')),
    (Join-Path $userProfile '.dotfiles')
)
$worklog = [IO.Path]::Combine($knowledge, '00 Inbox', 'Agent Worklog.md')
$stateRootDefault = if ($runningOnWindows -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Join-Path $env:LOCALAPPDATA 'IntegratedPower\state'
} elseif (-not [string]::IsNullOrWhiteSpace($env:XDG_STATE_HOME)) {
    Join-Path $env:XDG_STATE_HOME 'integrated-power'
} else {
    Join-Path $userProfile '.local\state\integrated-power'
}
$stateRoot = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_STATE_ROOT)) {
    ConvertTo-EggRAbsolutePath -PathValue $env:INTEGRATED_POWER_STATE_ROOT -Label 'INTEGRATED_POWER_STATE_ROOT'
} elseif ($configRoots.ContainsKey('state_root') -and -not [string]::IsNullOrWhiteSpace($configRoots['state_root'])) {
    ConvertTo-EggRAbsolutePath -PathValue $configRoots['state_root'] -Label 'roots.json state_root'
} else {
    ConvertTo-EggRAbsolutePath -PathValue $stateRootDefault -Label 'default state_root'
}
$toolsRootDefault = if ($runningOnWindows -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Join-Path $env:LOCALAPPDATA 'IntegratedPower\bin'
} elseif (-not [string]::IsNullOrWhiteSpace($env:XDG_DATA_HOME)) {
    Join-Path $env:XDG_DATA_HOME 'integrated-power\bin'
} else {
    Join-Path $userProfile '.local\share\integrated-power\bin'
}
$toolsRoot = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_TOOLS_ROOT)) {
    ConvertTo-EggRAbsolutePath -PathValue $env:INTEGRATED_POWER_TOOLS_ROOT -Label 'INTEGRATED_POWER_TOOLS_ROOT'
} elseif ($configRoots.ContainsKey('tools_root') -and -not [string]::IsNullOrWhiteSpace($configRoots['tools_root'])) {
    ConvertTo-EggRAbsolutePath -PathValue $configRoots['tools_root'] -Label 'roots.json tools_root'
} else {
    ConvertTo-EggRAbsolutePath -PathValue $toolsRootDefault -Label 'default tools_root'
}
$pluginRootDefault = Join-Path $userProfile '.gemini\config\plugins'
$pluginRoot = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ANTIGRAVITY_PLUGIN_ROOT)) {
    ConvertTo-EggRAbsolutePath -PathValue $env:INTEGRATED_POWER_ANTIGRAVITY_PLUGIN_ROOT -Label 'INTEGRATED_POWER_ANTIGRAVITY_PLUGIN_ROOT'
} elseif ($configRoots.ContainsKey('antigravity_plugin_root') -and -not [string]::IsNullOrWhiteSpace($configRoots['antigravity_plugin_root'])) {
    ConvertTo-EggRAbsolutePath -PathValue $configRoots['antigravity_plugin_root'] -Label 'roots.json antigravity_plugin_root'
} else {
    ConvertTo-EggRAbsolutePath -PathValue $pluginRootDefault -Label 'default antigravity_plugin_root'
}

foreach ($pair in @(
    @('Bootstrap', $bootstrap),
    @('Knowledge', $knowledge),
    @('Dotfiles', $dotfiles)
)) {
    if ((Test-Path -LiteralPath $pair[1]) -and -not (Test-PathInsideRoot -Candidate $pair[1] -Root $resolvedWorkRoot)) {
        $script:resolutionWarnings += "$($pair[0]) is outside WorkRoot; it remains in place until the user chooses a migration."
    }
}
if (-not (Test-Path -LiteralPath $resolvedWorkRoot)) {
    $script:resolutionWarnings += "Configured WorkRoot does not exist yet: $resolvedWorkRoot"
}

$result = [PSCustomObject]@{
    OS               = if ($runningOnWindows) { 'Windows' } else { 'Linux/macOS' }
    WorkRoot         = $resolvedWorkRoot
    WorkRootSource   = $workRootSource
    WorkRootExists   = Test-Path -LiteralPath $resolvedWorkRoot
    ConfigFile       = $configFile
    Bootstrap        = $bootstrap
    Knowledge        = $knowledge
    KnowledgeRemote  = $configuredKnowledgeRemote
    KnowledgeMode    = if ($configRoots.ContainsKey('knowledge_mode')) {
        $configRoots['knowledge_mode']
    } elseif (-not [string]::IsNullOrWhiteSpace($configuredKnowledgeRemote)) {
        'private_remote'
    } else {
        ''
    }
    Dotfiles         = $dotfiles
    Worklog          = $worklog
    StateRoot        = $stateRoot
    ToolsRoot        = $toolsRoot
    AntigravityPluginRoot = $pluginRoot
    Warnings         = @($script:resolutionWarnings)
}

if (-not [string]::IsNullOrWhiteSpace($Property)) {
    $selected = $result.PSObject.Properties[$Property]
    if ($null -eq $selected) {
        throw "Property '$Property' was not found on resolved roots."
    }
    Write-Output $selected.Value
} elseif ($Json) {
    $result | ConvertTo-Json -Depth 4 -Compress
} else {
    Write-Output $result
}
