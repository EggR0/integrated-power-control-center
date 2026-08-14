Set-StrictMode -Version Latest

function ConvertTo-IntegratedPowerTaskKey {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$TaskKey = "",

        [AllowEmptyString()]
        [string]$TaskTitle = ""
    )

    $source = if (-not [string]::IsNullOrWhiteSpace($TaskKey)) {
        $TaskKey
    }
    elseif (-not [string]::IsNullOrWhiteSpace($TaskTitle)) {
        $TaskTitle
    }
    else {
        "task"
    }

    $normalized = $source.Trim().ToLowerInvariant()
    $normalized = [regex]::Replace($normalized, "[^\p{L}\p{Nd}._-]+", "-")
    $normalized = $normalized.Trim("-", ".", "_")
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        $normalized = "task"
    }
    if ($normalized.Length -gt 80) {
        $normalized = $normalized.Substring(0, 80).TrimEnd("-", ".", "_")
    }
    if ($normalized -match "^(con|prn|aux|nul|com[1-9]|lpt[1-9])$") {
        $normalized = "task-$normalized"
    }

    return $normalized
}

function Get-IntegratedPowerAntigravityBrainSessionRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $current = Split-Path -Parent $fullPath
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent)) { break }

        if ((Split-Path -Leaf $parent) -ieq "brain") {
            $grandParent = Split-Path -Parent $parent
            if (-not [string]::IsNullOrWhiteSpace($grandParent) -and (Split-Path -Leaf $grandParent) -ieq "antigravity-ide") {
                return $current
            }
        }

        if ($parent -eq $current) { break }
        $current = $parent
    }

    return $null
}

function Resolve-IntegratedPowerArtifactTarget {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$OutputFile = "",

        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string]$StateRoot,

        [AllowEmptyString()]
        [string]$TaskKey = "",

        [AllowEmptyString()]
        [string]$TaskTitle = "",

        [ValidateSet("Coalesce", "Separate")]
        [string]$ArtifactPolicy = "Coalesce"
    )

    $resolvedTaskKey = ConvertTo-IntegratedPowerTaskKey -TaskKey $TaskKey -TaskTitle $TaskTitle
    $requestedPath = if ([string]::IsNullOrWhiteSpace($OutputFile)) {
        Join-Path $StateRoot "reports\tasks\$resolvedTaskKey.md"
    }
    elseif ([IO.Path]::IsPathRooted($OutputFile)) {
        $OutputFile
    }
    else {
        Join-Path $RepoRoot $OutputFile
    }
    $requestedPath = [IO.Path]::GetFullPath($requestedPath)

    $sessionRoot = Get-IntegratedPowerAntigravityBrainSessionRoot -Path $requestedPath
    $targetPath = $requestedPath
    $coalesced = $false
    if ($ArtifactPolicy -eq "Coalesce" -and -not [string]::IsNullOrWhiteSpace($sessionRoot)) {
        $targetPath = Join-Path $sessionRoot "ip-orchestrator.md"
        $coalesced = -not [string]::Equals(
            $requestedPath,
            $targetPath,
            [StringComparison]::OrdinalIgnoreCase
        )
    }

    return [pscustomobject]@{
        Path = $targetPath
        RequestedPath = $requestedPath
        TaskKey = $resolvedTaskKey
        BrainSessionRoot = $sessionRoot
        Coalesced = $coalesced
    }
}

function Write-IntegratedPowerArtifact {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Content,

        [ValidateSet("Replace", "Append")]
        [string]$Mode = "Replace",

        [AllowEmptyString()]
        [string]$TaskTitle = "",

        [AllowEmptyString()]
        [string]$Route = ""
    )

    $directory = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }

    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    if ($Mode -eq "Append" -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $labelParts = @(@($TaskTitle, $Route) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $label = if ($labelParts.Count -gt 0) { $labelParts -join " · " } else { "Integrated Orchestrator" }
        $section = "`r`n`r`n## $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') — $label`r`n`r`n$($Content.TrimEnd())`r`n"
        [IO.File]::AppendAllText($Path, $section, $utf8NoBom)
        return
    }

    [IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

Export-ModuleMember -Function @(
    "ConvertTo-IntegratedPowerTaskKey",
    "Get-IntegratedPowerAntigravityBrainSessionRoot",
    "Resolve-IntegratedPowerArtifactTarget",
    "Write-IntegratedPowerArtifact"
)
