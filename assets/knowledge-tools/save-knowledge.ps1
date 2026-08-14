<#
.SYNOPSIS
    Commits explicitly selected routed Knowledge files to canonical main.
.DESCRIPTION
    Accepts only files inside the fixed Obsidian Knowledge routes, rejects
    unrelated staged files and obvious plaintext secrets, commits on main, then
    rebases and pushes main without creating a task-named branch.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path,
    [string]$KnowledgePath = '',
    [string]$Message = 'Update global knowledge',
    [string]$AuthorName = '',
    [string]$AuthorEmail = '',
    [switch]$NoPush
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-CheckedGit {
    param([string[]]$Arguments)
    & $script:gitCommand -C $script:knowledgeRepo @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "git failed: git -C `"$script:knowledgeRepo`" $($Arguments -join ' ')"
    }
}

$resolver = Join-Path $PSScriptRoot 'eggr-roots.ps1'
if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
    throw "Knowledge root resolver was not found: $resolver"
}
if ([string]::IsNullOrWhiteSpace($KnowledgePath)) {
    $roots = (& $resolver -Json) | ConvertFrom-Json
    $script:knowledgeRepo = [string]$roots.Knowledge
} else {
    $script:knowledgeRepo = [IO.Path]::GetFullPath(
        [Environment]::ExpandEnvironmentVariables($KnowledgePath)
    ).TrimEnd('\', '/')
}
$gitInfo = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitInfo) {
    throw 'Git is required.'
}
$script:gitCommand = $gitInfo.Source
if (-not (Test-Path -LiteralPath (Join-Path $script:knowledgeRepo '.git'))) {
    throw "Knowledge is not a Git repository: $script:knowledgeRepo"
}

$branch = [string](@(& $script:gitCommand -C $script:knowledgeRepo branch --show-current) -join '')
$branch = $branch.Trim()
if ($branch -ne 'main') {
    throw "Knowledge canonical branch is 'main', but '$branch' is checked out. Consolidate the existing branch before saving; no new branch was created."
}

$allowedExact = @(
    'Home.md',
    'System Map.md',
    '.ai/knowledge-routing.json',
    '.ai/KNOWLEDGE_RULES.md'
)
$allowedPrefixes = @(
    '00 Inbox/',
    '10 Projects/',
    '20 Knowledge/',
    '30 Areas/',
    '90 Templates/'
)
$relativePaths = New-Object 'System.Collections.Generic.List[string]'
foreach ($inputPath in $Path) {
    if ([string]::IsNullOrWhiteSpace($inputPath)) {
        throw 'Knowledge Path entries cannot be empty.'
    }
    $candidate = $inputPath.Replace('\', '/').TrimStart('/')
    if ($candidate -match '(^|/)\.\.(/|$)' -or [IO.Path]::IsPathRooted($inputPath)) {
        throw "Knowledge Path must be repository-relative: $inputPath"
    }
    $allowed = $candidate -in $allowedExact
    if (-not $allowed) {
        $allowed = @($allowedPrefixes | Where-Object {
            $candidate.StartsWith($_, [StringComparison]::OrdinalIgnoreCase)
        }).Count -gt 0
    }
    if (-not $allowed -or [IO.Path]::GetExtension($candidate) -notin @('.md', '.json', '.canvas')) {
        throw "Knowledge Path is outside the allowed Obsidian routes: $inputPath"
    }
    if ($candidate -match '(?i)(^|/)(\.env|secrets?|credentials?)(\.|/|$)') {
        throw "Sensitive file names are not allowed in Knowledge sync: $inputPath"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $script:knowledgeRepo $candidate) -PathType Leaf)) {
        throw "Knowledge file does not exist; automatic deletion is not supported: $candidate"
    }
    $relativePaths.Add($candidate)
}
$selected = @($relativePaths | Sort-Object -Unique)

$staged = @(& $script:gitCommand -C $script:knowledgeRepo diff --cached --name-only)
$unexpectedStaged = @($staged | Where-Object { $_ -notin $selected })
if ($unexpectedStaged.Count -gt 0) {
    throw "Unrelated staged files block Knowledge sync: $($unexpectedStaged -join ', ')"
}

$addedLines = @(& $script:gitCommand -C $script:knowledgeRepo diff HEAD --unified=0 -- @selected) |
    Where-Object { $_ -match '^\+[^+]' }
$secretPattern = '(?i)(api[_-]?key|access[_-]?token|password|client[_-]?secret|private[_-]?key)\s*[:=]\s*\S+'
if ($addedLines -match $secretPattern) {
    throw 'Potential plaintext secret detected in selected Knowledge changes.'
}

$configuredName = [string](@(& $script:gitCommand -C $script:knowledgeRepo config user.name) -join '')
$configuredEmail = [string](@(& $script:gitCommand -C $script:knowledgeRepo config user.email) -join '')
if (([string]::IsNullOrWhiteSpace($configuredName) -or [string]::IsNullOrWhiteSpace($configuredEmail)) -and
    ([string]::IsNullOrWhiteSpace($AuthorName) -or [string]::IsNullOrWhiteSpace($AuthorEmail))) {
    throw 'Git author identity is missing.'
}

Invoke-CheckedGit -Arguments (@('add', '--') + $selected)
& $script:gitCommand -C $script:knowledgeRepo diff --cached --quiet -- @selected
$committed = $LASTEXITCODE -ne 0
if ($committed) {
    $commitArguments = @()
    if (-not [string]::IsNullOrWhiteSpace($AuthorName)) {
        $commitArguments += @('-c', "user.name=$AuthorName", '-c', "user.email=$AuthorEmail")
    }
    $commitArguments += @('commit', '-m', $Message, '--')
    $commitArguments += $selected
    Invoke-CheckedGit -Arguments $commitArguments
}

$pushed = $false
if (-not $NoPush) {
    $remotes = @(& $script:gitCommand -C $script:knowledgeRepo remote)
    if ($remotes -contains 'origin') {
        $remoteMain = @(& $script:gitCommand -C $script:knowledgeRepo ls-remote --heads origin refs/heads/main)
        if ($LASTEXITCODE -ne 0) {
            throw 'Knowledge origin could not be read.'
        }
        if ($remoteMain.Count -gt 0) {
            Invoke-CheckedGit -Arguments @('pull', '--rebase', '--autostash', 'origin', 'main')
        }
        Invoke-CheckedGit -Arguments @('push', '-u', 'origin', 'main')
        $pushed = $true
    }
}

[PSCustomObject]@{
    branch    = 'main'
    files     = $selected
    committed = $committed
    pushed    = $pushed
}
