Set-StrictMode -Version Latest

function Get-EggRUserHome {
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return [IO.Path]::GetFullPath($env:USERPROFILE)
    }

    $profilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ([string]::IsNullOrWhiteSpace($profilePath)) {
        throw "EggR could not resolve the current user profile."
    }

    return [IO.Path]::GetFullPath($profilePath)
}

function Get-EggRRootsConfig {
    $configPath = if (-not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ROOTS_CONFIG)) {
        [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:INTEGRATED_POWER_ROOTS_CONFIG))
    } else {
        Join-Path (Get-EggRUserHome) ".config\integrated-power\roots.json"
    }
    if (!(Test-Path -LiteralPath $configPath -PathType Leaf) -and
        [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_ROOTS_CONFIG)) {
        $previousConfigPath = Join-Path (Get-EggRUserHome) ".config\eggr\roots.json"
        if (Test-Path -LiteralPath $previousConfigPath -PathType Leaf) {
            $configPath = $previousConfigPath
        } else {
            return @{}
        }
    }
    if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) { return @{} }

    try {
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $result = @{}
        foreach ($property in $config.PSObject.Properties) {
            $result[$property.Name] = [string]$property.Value
        }
        return $result
    } catch {
        throw "EggR roots config is invalid: $configPath. $($_.Exception.Message)"
    }
}

function Get-EggRStateRoot {
    $explicitProductRoot = -not [string]::IsNullOrWhiteSpace($env:INTEGRATED_POWER_STATE_ROOT)
    $candidate = if ($explicitProductRoot) {
        $env:INTEGRATED_POWER_STATE_ROOT
    } else {
        $env:EGGR_STATE_ROOT
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $config = Get-EggRRootsConfig
        if ($config.ContainsKey("state_root")) {
            $candidate = $config["state_root"]
        }
    }

    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $runningOnWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
        if ($runningOnWindows -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            $candidate = Join-Path $env:LOCALAPPDATA "IntegratedPower\state"
        } elseif (-not [string]::IsNullOrWhiteSpace($env:XDG_STATE_HOME)) {
            $candidate = Join-Path $env:XDG_STATE_HOME "integrated-power"
        } else {
            $candidate = Join-Path (Get-EggRUserHome) ".local\state\integrated-power"
        }
    }

    $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
    $userHome = Get-EggRUserHome
    if ($expanded -eq '~') {
        $expanded = $userHome
    } elseif ($expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) {
        $expanded = Join-Path $userHome $expanded.Substring(2)
    }
    $resolved = [IO.Path]::GetFullPath($expanded)
    if (-not $explicitProductRoot -and
        [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and
        -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $legacyDefault = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "EggR\state"))
        if ($resolved.Equals($legacyDefault, [StringComparison]::OrdinalIgnoreCase)) {
            return [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "IntegratedPower\state"))
        }
    }
    return $resolved
}

function Get-EggRRepositoryRoot {
    param([string]$StartPath = (Get-Location).Path)

    $fullStartPath = [IO.Path]::GetFullPath($StartPath)
    try {
        $gitRoot = (& git -C $fullStartPath rev-parse --show-toplevel 2>$null | Select-Object -First 1)
        if (-not [string]::IsNullOrWhiteSpace($gitRoot)) {
            return [IO.Path]::GetFullPath($gitRoot.Trim())
        }
    } catch {
        # A non-Git workspace is valid and falls back to its resolved path.
    }

    return $fullStartPath
}

function Get-EggRSha256 {
    param([Parameter(Mandatory = $true)][string]$Text)

    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
    } finally {
        $sha.Dispose()
    }
}

function ConvertTo-EggRRemoteIdentity {
    param([Parameter(Mandatory = $true)][string]$RemoteUrl)

    $identity = $RemoteUrl.Trim().Replace("\", "/")
    $identity = $identity -replace "^[^@/]+@([^:/]+):", '$1/'
    $identity = $identity -replace "^[a-zA-Z][a-zA-Z0-9+.-]*://", ""
    $identity = $identity -replace "^[^@/]+@", ""
    $identity = $identity.TrimEnd("/")
    $identity = $identity -replace "\.git$", ""
    return $identity.ToLowerInvariant()
}

function Get-EggRWorkspaceId {
    param([string]$RepoRoot = (Get-Location).Path)

    $root = Get-EggRRepositoryRoot -StartPath $RepoRoot
    $workspaceConfig = Join-Path $root ".eggr\workspace.json"
    if (Test-Path -LiteralPath $workspaceConfig -PathType Leaf) {
        try {
            $workspaceData = Get-Content -LiteralPath $workspaceConfig -Raw -Encoding UTF8 | ConvertFrom-Json
            $configuredId = [string]$workspaceData.id
            if ($configuredId -match "^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$") {
                return $configuredId
            }
            throw "id must match ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$"
        } catch {
            throw "EggR workspace config is invalid: $workspaceConfig. $($_.Exception.Message)"
        }
    }

    try {
        $remote = (& git -C $root config --get remote.origin.url 2>$null | Select-Object -First 1)
        if (-not [string]::IsNullOrWhiteSpace($remote)) {
            $remoteIdentity = ConvertTo-EggRRemoteIdentity -RemoteUrl $remote
            return "git-$((Get-EggRSha256 -Text $remoteIdentity).Substring(0, 24))"
        }
    } catch {
        # Repositories without an origin use a path-derived fallback.
    }

    $pathIdentity = [IO.Path]::GetFullPath($root).Replace("\", "/").TrimEnd("/")
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $pathIdentity = $pathIdentity.ToLowerInvariant()
    }
    return "path-$((Get-EggRSha256 -Text $pathIdentity).Substring(0, 24))"
}

function Get-EggRWorkspaceStatePath {
    param(
        [string]$RepoRoot = (Get-Location).Path,
        [string]$StateRoot = ""
    )

    if ([string]::IsNullOrWhiteSpace($StateRoot)) {
        $StateRoot = Get-EggRStateRoot
    }

    return Join-Path ([IO.Path]::GetFullPath($StateRoot)) "workspaces\$(Get-EggRWorkspaceId -RepoRoot $RepoRoot)"
}

function Get-GlobalStorage {
    param([string]$RepoRoot = (Get-Location).Path)

    # Backward-compatible function name for existing EggR scripts.
    return Get-EggRWorkspaceStatePath -RepoRoot $RepoRoot
}

Export-ModuleMember -Function @(
    "ConvertTo-EggRRemoteIdentity",
    "Get-EggRRepositoryRoot",
    "Get-EggRRootsConfig",
    "Get-EggRStateRoot",
    "Get-EggRWorkspaceId",
    "Get-EggRWorkspaceStatePath",
    "Get-GlobalStorage"
)
