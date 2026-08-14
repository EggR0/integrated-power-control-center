<#
.SYNOPSIS
    Resolves an Obsidian Knowledge document to one deterministic allowed path.
.DESCRIPTION
    Reads .ai/knowledge-routing.json, reuses an existing document when its id or
    normalized title matches, and otherwise proposes a path under an allowed
    top-level folder. It never creates a new top-level folder.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('worklog', 'inbox', 'project', 'knowledge', 'area', 'template')]
    [string]$Kind,
    [string]$Title = '',
    [string]$DocumentId = '',
    [string]$KnowledgePath = '',
    [switch]$Create,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-NormalizedTitle {
    param([string]$Value)
    return (($Value -replace '[^\p{L}\p{Nd}]+', ' ').Trim().ToLowerInvariant())
}

function ConvertTo-SafeFileName {
    param([string]$Value)
    $name = ($Value -replace '[<>:"/\\|?*\x00-\x1F]', ' ').Trim().TrimEnd('.')
    $name = ($name -replace '\s+', ' ')
    if ([string]::IsNullOrWhiteSpace($name)) {
        throw 'Title does not contain a usable file name.'
    }
    if ($name -match '^(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
        throw "Title resolves to a reserved Windows file name: $name"
    }
    return $name
}

if ([string]::IsNullOrWhiteSpace($KnowledgePath)) {
    $resolver = Join-Path $PSScriptRoot 'eggr-roots.ps1'
    if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
        throw "Knowledge root resolver was not found: $resolver"
    }
    $KnowledgePath = [string](& $resolver -Property Knowledge)
}
$KnowledgePath = [IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($KnowledgePath)
).TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath $KnowledgePath -PathType Container)) {
    throw "Knowledge directory does not exist: $KnowledgePath"
}

$policyPath = Join-Path $KnowledgePath '.ai\knowledge-routing.json'
if (-not (Test-Path -LiteralPath $policyPath -PathType Leaf)) {
    throw "Knowledge routing policy is missing. Run initialize-eggr-knowledge first: $policyPath"
}
$policy = Get-Content -Raw -Encoding UTF8 -LiteralPath $policyPath | ConvertFrom-Json
if ([int]$policy.schema_version -ne 1 -or $policy.allow_new_top_level -ne $false) {
    throw "Unsupported or unsafe Knowledge routing policy: $policyPath"
}
$route = $policy.routes.PSObject.Properties[$Kind]
if ($null -eq $route) {
    throw "Route '$Kind' is not defined in $policyPath"
}

if ($Kind -eq 'worklog') {
    $relativePath = Join-Path ([string]$route.Value.directory) ([string]$route.Value.file)
    $titleValue = 'Agent Worklog'
} else {
    if ([string]::IsNullOrWhiteSpace($Title)) {
        throw "Title is required for route '$Kind'."
    }
    $titleValue = ConvertTo-SafeFileName -Value $Title
    $relativePath = Join-Path ([string]$route.Value.directory) "$titleValue.md"
}

$normalizedTitle = ConvertTo-NormalizedTitle -Value $titleValue
$matches = New-Object 'System.Collections.Generic.List[string]'
foreach ($file in @(Get-ChildItem -LiteralPath $KnowledgePath -File -Recurse -Filter '*.md' |
    Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' })) {
    $relative = $file.FullName.Substring($KnowledgePath.Length).TrimStart('\', '/')
    if ((ConvertTo-NormalizedTitle -Value $file.BaseName) -eq $normalizedTitle) {
        $matches.Add($relative)
        continue
    }
    if (-not [string]::IsNullOrWhiteSpace($DocumentId)) {
        $head = [IO.File]::ReadLines($file.FullName) | Select-Object -First 60
        if ($head -match ("^\s*id\s*:\s*['`"]?{0}['`"]?\s*$" -f [Regex]::Escape($DocumentId))) {
            $matches.Add($relative)
        }
    }
}
$uniqueMatches = @($matches | Sort-Object -Unique)
if ($uniqueMatches.Count -gt 1) {
    throw "Knowledge routing is ambiguous. Resolve duplicate id/title matches first: $($uniqueMatches -join ', ')"
}
if ($uniqueMatches.Count -eq 1) {
    $relativePath = $uniqueMatches[0]
    $status = 'existing'
} else {
    $status = 'proposed'
}

$absolutePath = Join-Path $KnowledgePath $relativePath
if ($Create -and $status -eq 'proposed' -and $PSCmdlet.ShouldProcess($absolutePath, 'Create routed Knowledge document')) {
    $parent = Split-Path -Parent $absolutePath
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $idLine = if ([string]::IsNullOrWhiteSpace($DocumentId)) { '' } else { "id: $DocumentId`n" }
    $content = "---`ntype: $Kind`n${idLine}created: $([DateTime]::Now.ToString('yyyy-MM-dd'))`n---`n`n# $titleValue`n"
    [IO.File]::WriteAllText($absolutePath, $content, (New-Object Text.UTF8Encoding($false)))
    $status = 'created'
}

$result = [PSCustomObject]@{
    schema_version = 1
    kind           = $Kind
    status         = $status
    relative_path  = $relativePath.Replace('\', '/')
    absolute_path  = $absolutePath
    canonical_branch = [string]$policy.canonical_branch
}
if ($Json) {
    $result | ConvertTo-Json -Depth 4 -Compress
} else {
    $result
}
