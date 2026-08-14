<#
.SYNOPSIS
    Persists the user's EggR path choices without moving existing files.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkRoot,
    [string]$Knowledge = "",
    [string]$KnowledgeRemote = "",
    [ValidateSet('', 'local_only', 'private_remote')]
    [string]$KnowledgeMode = "",
    [string]$Bootstrap = "",
    [string]$Dotfiles = "",
    [string]$StateRoot = "",
    [string]$ToolsRoot = "",
    [string]$AntigravityPluginRoot = "",
    [switch]$ClearKnowledgeRemote,
    [switch]$CreateWorkRoot,
    [switch]$Json,
    [Parameter(DontShow = $true)]
    [string]$ConfigFileOverride = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$userProfile = [Environment]::GetFolderPath('UserProfile')
$configFile = if (-not [string]::IsNullOrWhiteSpace($ConfigFileOverride)) {
    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($ConfigFileOverride))
} elseif (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ROOTS_CONFIG)) {
    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:INTEGRATED_POWER_ROOTS_CONFIG))
} else {
    Join-Path $userProfile '.config\integrated-power\roots.json'
}
$configDirectory = Split-Path -Parent $configFile

function ConvertTo-SafeAbsolutePath {
    param(
        [string]$PathValue,
        [string]$Label
    )

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
    if ($fullPath.TrimEnd('\', '/') -eq $pathRoot.TrimEnd('\', '/')) {
        throw "$Label cannot be a filesystem root: $fullPath"
    }
    return $fullPath.TrimEnd('\', '/')
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
            throw 'KnowledgeRemote is not a valid Git URL.'
        }
    }
    return $candidate -match '^(?i)(https?|git)://[^/]*@'
}

$resolvedWorkRoot = ConvertTo-SafeAbsolutePath -PathValue $WorkRoot -Label 'WorkRoot'
$values = [ordered]@{}
if (Test-Path -LiteralPath $configFile -PathType Leaf) {
    try {
        $existing = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
        foreach ($property in $existing.PSObject.Properties) {
            $values[$property.Name] = $property.Value
        }
    } catch {
        throw "Existing roots config is invalid; repair it before overwriting: $configFile"
    }
}
if ($values.Contains('knowledge_remote') -and
    (Test-RemoteContainsCredential -Value ([string]$values['knowledge_remote']))) {
    throw "Existing roots config contains embedded Knowledge remote credentials. Remove them before updating: $configFile"
}

$values['work_root'] = $resolvedWorkRoot
foreach ($pair in @(
    @('knowledge', $Knowledge),
    @('bootstrap', $Bootstrap),
    @('dotfiles', $Dotfiles),
    @('state_root', $StateRoot),
    @('tools_root', $ToolsRoot),
    @('antigravity_plugin_root', $AntigravityPluginRoot)
)) {
    if (-not [string]::IsNullOrWhiteSpace($pair[1])) {
        $values[$pair[0]] = ConvertTo-SafeAbsolutePath -PathValue $pair[1] -Label $pair[0]
    }
}
if ($ClearKnowledgeRemote) {
    $values.Remove('knowledge_remote')
} elseif (-not [string]::IsNullOrWhiteSpace($KnowledgeRemote)) {
    if (Test-RemoteContainsCredential -Value $KnowledgeRemote) {
        throw 'KnowledgeRemote contains embedded credentials. Store authentication in Git Credential Manager or an SSH agent instead.'
    }
    $values['knowledge_remote'] = $KnowledgeRemote.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($KnowledgeMode)) {
    $values['knowledge_mode'] = $KnowledgeMode
}
if ($KnowledgeMode -eq 'local_only') {
    $values.Remove('knowledge_remote')
} elseif ($KnowledgeMode -eq 'private_remote' -and
    (-not $values.Contains('knowledge_remote') -or [string]::IsNullOrWhiteSpace([string]$values['knowledge_remote']))) {
    throw 'KnowledgeMode private_remote requires a credential-free KnowledgeRemote.'
}

if ($CreateWorkRoot -and -not (Test-Path -LiteralPath $resolvedWorkRoot)) {
    if ($PSCmdlet.ShouldProcess($resolvedWorkRoot, 'Create EggR work root')) {
        New-Item -ItemType Directory -Path $resolvedWorkRoot -Force | Out-Null
    }
}

if ($PSCmdlet.ShouldProcess($configFile, 'Save EggR root preferences')) {
    New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
    $temporaryFile = Join-Path $configDirectory ("roots.{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
    try {
        $serializedRoots = $values | ConvertTo-Json -Depth 4
        [IO.File]::WriteAllText($temporaryFile, "$serializedRoots`n", (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporaryFile -Destination $configFile -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryFile) {
            Remove-Item -LiteralPath $temporaryFile -Force
        }
    }
}

$resolver = Join-Path $PSScriptRoot 'eggr-roots.ps1'
if ($Json) {
    & $resolver -Json
} else {
    & $resolver
}
