<#
.SYNOPSIS
    First-run wizard for a user-owned EggR knowledge Git repository on Windows 11.
.DESCRIPTION
    Creates or connects the local Knowledge repository selected by the user and
    persists that selection in roots.json. Existing repositories, branches, and
    dirty changes are preserved. Credentials are delegated to Git Credential
    Manager or the user's SSH agent; passwords and tokens are never accepted.

    This command never commits, pulls, rebases, checks out a branch, or pushes.
.PARAMETER KnowledgePath
    Absolute local path for the user's Knowledge repository. Defaults to the
    dynamically resolved Knowledge path.
.PARAMETER WorkRoot
    Absolute common root selected for this PC. It is persisted locally and is
    not inferred from another user's checkout path.
.PARAMETER ToolsRoot
    Absolute directory where this PC keeps the Integrated Power Knowledge
    commands. Defaults to the resolver result.
.PARAMETER RemoteUrl
    Optional private Git remote. HTTPS, SSH, and Git-supported local URLs are
    accepted, but URLs containing embedded credentials are rejected.
.PARAMETER AuthorName
    Repository-local git user.name. Existing local/global values are proposed.
.PARAMETER AuthorEmail
    Repository-local git user.email. Existing local/global values are proposed.
.PARAMETER DefaultBranch
    Initial branch name for a new empty repository. Existing repositories never
    switch branches.
.PARAMETER NonInteractive
    Disable all prompts. Required values must be supplied or already configured.
.PARAMETER AllowNonEmptyDirectory
    Allow Git initialization inside an existing non-empty, non-Git directory.
    This does not delete or stage any existing file.
.PARAMETER SkipRemoteCheck
    Save an origin without probing it. Intended for offline setup and diagnostics.
.PARAMETER LocalOnly
    Do not add a remote to a new repository. An origin already present in an
    existing repository is preserved and remains the effective remote.
.PARAMETER SkipRootPersistence
    Do not update roots.json. Useful for isolated tests or temporary repositories.
.PARAMETER DryRun
    Show the resolved plan without changing files or Git configuration.
.PARAMETER Json
    Emit the final diagnostic object as JSON.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [string]$KnowledgePath = '',
    [string]$WorkRoot = '',
    [string]$ToolsRoot = '',
    [string]$RemoteUrl = '',
    [string]$AuthorName = '',
    [string]$AuthorEmail = '',
    [ValidatePattern('^(?![./-])[A-Za-z0-9._/-]+$')]
    [string]$DefaultBranch = 'main',
    [switch]$NonInteractive,
    [switch]$AllowNonEmptyDirectory,
    [switch]$SkipRemoteCheck,
    [switch]$LocalOnly,
    [switch]$SkipRootPersistence,
    [switch]$DryRun,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$previewOnly = $DryRun -or [bool]$WhatIfPreference

function Write-WizardStatus {
    param([string]$State, [string]$Message)
    if (-not $Json) {
        Write-Host "[$State] $Message"
    }
}

function Write-Utf8NoBomIfMissing {
    param(
        [string]$Path,
        [string]$Content,
        [System.Collections.Generic.List[string]]$Created
    )

    if (Test-Path -LiteralPath $Path) {
        return
    }
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
    $Created.Add($Path)
}

function Initialize-KnowledgeScaffold {
    param([string]$Root)

    $created = New-Object 'System.Collections.Generic.List[string]'
    foreach ($directory in @(
        '.ai',
        '00 Inbox',
        '10 Projects',
        '20 Knowledge',
        '30 Areas',
        '90 Templates'
    )) {
        $target = Join-Path $Root $directory
        if (-not (Test-Path -LiteralPath $target)) {
            New-Item -ItemType Directory -Force -Path $target | Out-Null
            $created.Add($target)
        }
    }

    $routing = @'
{
  "schema_version": 1,
  "canonical_branch": "main",
  "allow_new_top_level": false,
  "fallback_route": "inbox",
  "resolution_order": [
    "document_id",
    "aliases",
    "normalized_title",
    "existing_links",
    "route_fallback"
  ],
  "routes": {
    "worklog": {
      "directory": "00 Inbox",
      "file": "Agent Worklog.md",
      "purpose": "task completion audit log"
    },
    "inbox": {
      "directory": "00 Inbox",
      "purpose": "unclassified temporary notes"
    },
    "project": {
      "directory": "10 Projects",
      "purpose": "projects with an end condition"
    },
    "knowledge": {
      "directory": "20 Knowledge",
      "purpose": "reusable cross-project knowledge and methods"
    },
    "area": {
      "directory": "30 Areas",
      "purpose": "ongoing responsibilities and operations"
    },
    "template": {
      "directory": "90 Templates",
      "purpose": "reusable document templates"
    }
  },
  "agent_rules": [
    "Search existing document ids, aliases, titles, and file names first.",
    "Update an existing note instead of creating a duplicate.",
    "Use 00 Inbox when classification is uncertain.",
    "Do not create a new top-level folder.",
    "Do not use Git branches as knowledge categories.",
    "Knowledge main is the canonical global store."
  ]
}
'@
    $rules = @'
# Knowledge Rules

Git `main` is the canonical global store. A branch is not a knowledge category.

1. Read `.ai/knowledge-routing.json` and search existing Markdown first.
2. Reuse a matching id, alias, title, or file name.
3. Put new notes only in a declared route.
4. Use `00 Inbox` when classification is uncertain.
5. Do not create an undeclared top-level folder.
6. Validate the destination with `route-knowledge`.
7. Save explicit files with `save-knowledge`.
8. Save the central audit line with `save-agent-worklog`.
'@
    $homePageContent = @'
# Home

- [[System Map]]
- [[00 Inbox/Inbox]]
- [[10 Projects/Projects]]
- [[20 Knowledge/Knowledge]]
- [[30 Areas/Areas]]
'@
    $systemMap = @'
# System Map

This Obsidian vault is the single user-owned global Knowledge store.

- `00 Inbox`: uncertain notes and Agent Worklog
- `10 Projects`: projects with an end condition
- `20 Knowledge`: reusable knowledge and methods
- `30 Areas`: ongoing responsibilities and operations
- `90 Templates`: reusable templates
- `.ai`: machine-readable routing and handoff rules

Agents must not create top-level folders absent from `.ai/knowledge-routing.json`.
'@

    Write-Utf8NoBomIfMissing -Path (Join-Path $Root '.ai\knowledge-routing.json') -Content $routing -Created $created
    Write-Utf8NoBomIfMissing -Path (Join-Path $Root '.ai\KNOWLEDGE_RULES.md') -Content $rules -Created $created
    Write-Utf8NoBomIfMissing -Path (Join-Path $Root 'Home.md') -Content $homePageContent -Created $created
    Write-Utf8NoBomIfMissing -Path (Join-Path $Root 'System Map.md') -Content $systemMap -Created $created
    Write-Utf8NoBomIfMissing -Path (Join-Path $Root '00 Inbox\Inbox.md') -Content "# Inbox`n`nTemporary notes whose durable route is not yet clear.`n" -Created $created
    Write-Utf8NoBomIfMissing -Path (Join-Path $Root '10 Projects\Projects.md') -Content "# Projects`n`nProjects with an explicit end condition.`n" -Created $created
    Write-Utf8NoBomIfMissing -Path (Join-Path $Root '20 Knowledge\Knowledge.md') -Content "# Knowledge`n`nReusable cross-project knowledge and methods.`n" -Created $created
    Write-Utf8NoBomIfMissing -Path (Join-Path $Root '30 Areas\Areas.md') -Content "# Areas`n`nOngoing responsibilities and operations.`n" -Created $created
    Write-Utf8NoBomIfMissing -Path (Join-Path $Root '90 Templates\Project.md') -Content "---`ntype: project`nstatus: active`n---`n`n# Project name`n" -Created $created
    return @($created)
}

function Resolve-Executable {
    param([string]$Name, [string[]]$Fallbacks = @())

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    foreach ($fallback in $Fallbacks) {
        if ($fallback -and (Test-Path -LiteralPath $fallback -PathType Leaf)) {
            return $fallback
        }
    }
    return $null
}

function ConvertTo-SafeAbsolutePath {
    param([string]$PathValue, [string]$Label)

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        throw "$Label cannot be empty."
    }
    $userProfile = [Environment]::GetFolderPath('UserProfile')
    $expanded = [Environment]::ExpandEnvironmentVariables($PathValue.Trim())
    if ($expanded -eq '~') {
        $expanded = $userProfile
    } elseif ($expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) {
        $expanded = Join-Path $userProfile $expanded.Substring(2)
    }
    if (-not [IO.Path]::IsPathRooted($expanded)) {
        throw "$Label must be an absolute path: $PathValue"
    }
    $fullPath = [IO.Path]::GetFullPath($expanded).TrimEnd('\', '/')
    $pathRoot = [IO.Path]::GetPathRoot($fullPath).TrimEnd('\', '/')
    if ($fullPath -eq $pathRoot) {
        throw "$Label cannot be a filesystem root: $fullPath"
    }
    return $fullPath
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
            throw 'RemoteUrl is not a valid Git URL.'
        }
    }
    return $candidate -match '^(?i)(https?|git)://[^/]*@'
}

function Normalize-RemoteForComparison {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ''
    }
    return $Value.Trim().TrimEnd('/').Replace('\', '/').Replace('.git', '')
}

function Invoke-GitCapture {
    param(
        [string[]]$Arguments,
        [switch]$AllowFailure,
        [switch]$NoPrompt
    )

    $previousPrompt = $env:GIT_TERMINAL_PROMPT
    $previousErrorPreference = $ErrorActionPreference
    if ($NoPrompt) {
        $env:GIT_TERMINAL_PROMPT = '0'
    }
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $script:gitCommand @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorPreference
        if ($NoPrompt) {
            if ($null -eq $previousPrompt) {
                Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
            } else {
                $env:GIT_TERMINAL_PROMPT = $previousPrompt
            }
        }
    }
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        $safeCommand = @($Arguments | Where-Object { $_ -ne $RemoteUrl }) -join ' '
        throw "git command failed (exit $exitCode): git $safeCommand"
    }
    return [PSCustomObject]@{
        ExitCode = $exitCode
        Output   = @($output | ForEach-Object { [string]$_ })
    }
}

function Get-GitConfigValue {
    param([string]$Repository, [string]$Name)

    $arguments = @()
    if (-not [string]::IsNullOrWhiteSpace($Repository)) {
        $arguments += @('-C', $Repository, 'config', '--get', $Name)
    } else {
        $arguments += @('config', '--global', '--get', $Name)
    }
    $result = Invoke-GitCapture -Arguments $arguments -AllowFailure
    if ($result.ExitCode -eq 0) {
        return ([string]($result.Output -join "`n")).Trim()
    }
    return ''
}

function Read-Value {
    param([string]$Prompt, [string]$DefaultValue, [switch]$Optional)

    $suffix = if ([string]::IsNullOrWhiteSpace($DefaultValue)) { '' } else { " [$DefaultValue]" }
    $answer = Read-Host "$Prompt$suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) {
        if (-not $Optional -and [string]::IsNullOrWhiteSpace($DefaultValue)) {
            throw "$Prompt is required."
        }
        return $DefaultValue
    }
    return $answer.Trim()
}

if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'initialize-eggr-knowledge.ps1 currently supports native Windows 11 only.'
}

$script:gitCommand = Resolve-Executable -Name 'git' -Fallbacks @(
    'C:\Program Files\Git\cmd\git.exe',
    'C:\Program Files\Git\bin\git.exe',
    (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local\Programs\Git\cmd\git.exe')
)
if (-not $script:gitCommand) {
    throw 'Git for Windows is required. Install it, sign in through Git Credential Manager, and rerun this wizard.'
}

$rootResolver = Join-Path $PSScriptRoot 'eggr-roots.ps1'
$rootSetter = Join-Path $PSScriptRoot 'set-eggr-roots.ps1'
if (-not (Test-Path -LiteralPath $rootResolver -PathType Leaf)) {
    throw "EggR root resolver was not found beside this wizard: $rootResolver"
}
$roots = (& $rootResolver -Json) | ConvertFrom-Json
$defaultKnowledgePath = [string]$roots.Knowledge
$defaultWorkRoot = [string]$roots.WorkRoot
$defaultToolsRoot = [string]$roots.ToolsRoot
$configuredRemote = if ($roots.PSObject.Properties['KnowledgeRemote']) {
    [string]$roots.KnowledgeRemote
} else {
    ''
}
if ([string]::IsNullOrWhiteSpace($RemoteUrl) -and -not $LocalOnly) {
    $RemoteUrl = $configuredRemote
}

if (-not $NonInteractive) {
    $KnowledgePath = Read-Value -Prompt 'Knowledge local path' -DefaultValue $(
        if ([string]::IsNullOrWhiteSpace($KnowledgePath)) { $defaultKnowledgePath } else { $KnowledgePath }
    )
}
if ([string]::IsNullOrWhiteSpace($KnowledgePath)) {
    $KnowledgePath = $defaultKnowledgePath
}
$WorkRoot = ConvertTo-SafeAbsolutePath -PathValue $(
    if ([string]::IsNullOrWhiteSpace($WorkRoot)) { $defaultWorkRoot } else { $WorkRoot }
) -Label 'WorkRoot'
$ToolsRoot = ConvertTo-SafeAbsolutePath -PathValue $(
    if ([string]::IsNullOrWhiteSpace($ToolsRoot)) { $defaultToolsRoot } else { $ToolsRoot }
) -Label 'ToolsRoot'
$KnowledgePath = ConvertTo-SafeAbsolutePath -PathValue $KnowledgePath -Label 'KnowledgePath'

$isRepository = Test-Path -LiteralPath (Join-Path $KnowledgePath '.git')
$configProbePath = if ($isRepository) { $KnowledgePath } else { '' }
$existingAuthorName = Get-GitConfigValue -Repository $configProbePath -Name 'user.name'
$existingAuthorEmail = Get-GitConfigValue -Repository $configProbePath -Name 'user.email'

if (-not $NonInteractive) {
    $AuthorName = Read-Value -Prompt 'Git author name' -DefaultValue $(
        if ([string]::IsNullOrWhiteSpace($AuthorName)) { $existingAuthorName } else { $AuthorName }
    )
    $AuthorEmail = Read-Value -Prompt 'Git author email (or GitHub noreply email)' -DefaultValue $(
        if ([string]::IsNullOrWhiteSpace($AuthorEmail)) { $existingAuthorEmail } else { $AuthorEmail }
    )
    $RemoteUrl = Read-Value -Prompt 'Private Git remote URL (type - for local-only)' -DefaultValue $(
        if ([string]::IsNullOrWhiteSpace($RemoteUrl)) { '' } else { $RemoteUrl }
    ) -Optional
    if ($RemoteUrl -eq '-') {
        $RemoteUrl = ''
        $LocalOnly = $true
    }
}
if ([string]::IsNullOrWhiteSpace($AuthorName)) {
    $AuthorName = $existingAuthorName
}
if ([string]::IsNullOrWhiteSpace($AuthorEmail)) {
    $AuthorEmail = $existingAuthorEmail
}
if ([string]::IsNullOrWhiteSpace($AuthorName) -or [string]::IsNullOrWhiteSpace($AuthorEmail)) {
    throw 'Git author name and email are required. Supply -AuthorName and -AuthorEmail or configure them in Git.'
}
if ($AuthorEmail -notmatch '^[^@\s]+@[^@\s]+$') {
    throw 'AuthorEmail does not look like an email address.'
}
$RemoteUrl = $RemoteUrl.Trim()
if (Test-RemoteContainsCredential -Value $RemoteUrl) {
    throw 'RemoteUrl contains embedded credentials. Use a clean URL and let Git Credential Manager or SSH handle authentication.'
}

$targetExists = Test-Path -LiteralPath $KnowledgePath
$targetItems = @()
if ($targetExists) {
    $targetItems = @(Get-ChildItem -Force -LiteralPath $KnowledgePath)
}
$targetNonEmpty = $targetItems.Count -gt 0
if ($targetExists -and -not (Test-Path -LiteralPath $KnowledgePath -PathType Container)) {
    throw "KnowledgePath exists but is not a directory: $KnowledgePath"
}
if ($targetNonEmpty -and -not $isRepository -and -not $AllowNonEmptyDirectory -and -not $previewOnly) {
    if ($NonInteractive) {
        throw 'KnowledgePath is a non-empty, non-Git directory. Rerun with -AllowNonEmptyDirectory after reviewing its contents.'
    }
    $approved = $PSCmdlet.ShouldContinue(
        "Initialize Git without deleting or staging the existing files in '$KnowledgePath'?",
        'Non-empty directory'
    )
    if (-not $approved) {
        throw 'Knowledge setup was cancelled; no files were changed.'
    }
}

$existingOrigin = ''
$dirtyLines = @()
$currentBranch = ''
if ($isRepository) {
    $originResult = Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'remote', 'get-url', 'origin') -AllowFailure
    if ($originResult.ExitCode -eq 0) {
        $existingOrigin = ([string]($originResult.Output -join "`n")).Trim()
        if (Test-RemoteContainsCredential -Value $existingOrigin) {
            throw 'The existing origin contains embedded credentials. Remove them from .git/config before rerunning.'
        }
    }
    $statusResult = Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'status', '--porcelain')
    $dirtyLines = @($statusResult.Output)
    $branchResult = Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'branch', '--show-current') -AllowFailure
    $currentBranch = ([string]($branchResult.Output -join '')).Trim()
}
if ([string]::IsNullOrWhiteSpace($RemoteUrl) -and -not [string]::IsNullOrWhiteSpace($existingOrigin)) {
    $RemoteUrl = $existingOrigin
}
if (Test-RemoteContainsCredential -Value $RemoteUrl) {
    throw 'The effective origin contains embedded credentials. Remove them from .git/config before rerunning.'
}

if (-not [string]::IsNullOrWhiteSpace($RemoteUrl) -and
    -not [string]::IsNullOrWhiteSpace($existingOrigin) -and
    (Normalize-RemoteForComparison -Value $RemoteUrl) -ne (Normalize-RemoteForComparison -Value $existingOrigin)) {
    throw 'The existing origin differs from the requested remote. It was not replaced; review `git remote -v` and resolve the conflict explicitly.'
}

$remoteChecked = $false
$remoteReachable = $null
$remoteHasRefs = $false
$credentialHelpers = @()
if (-not [string]::IsNullOrWhiteSpace($RemoteUrl)) {
    $helperResult = Invoke-GitCapture -Arguments @('config', '--global', '--get-all', 'credential.helper') -AllowFailure
    if ($helperResult.ExitCode -eq 0) {
        $credentialHelpers = @($helperResult.Output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    if (-not $SkipRemoteCheck) {
        $remoteResult = Invoke-GitCapture -Arguments @(
            '-c', 'credential.interactive=never', 'ls-remote', '--heads', '--tags', $RemoteUrl
        ) -AllowFailure -NoPrompt
        $remoteChecked = $true
        $remoteReachable = $remoteResult.ExitCode -eq 0
        $remoteHasRefs = $remoteReachable -and $remoteResult.Output.Count -gt 0
        if (-not $remoteReachable) {
            throw 'The private remote was not reachable without prompting. Sign in through Git Credential Manager (or start your SSH agent), then rerun; no credential was stored by EggR.'
        }
    }
}

$operation = 'reuse'
if (-not $isRepository) {
    if (-not [string]::IsNullOrWhiteSpace($RemoteUrl) -and $remoteHasRefs -and -not $targetNonEmpty) {
        $operation = 'clone'
    } else {
        $operation = 'initialize'
    }
}

$diagnostic = [ordered]@{
    schema_version          = 1
    knowledge_path         = $KnowledgePath
    work_root              = $WorkRoot
    tools_root             = $ToolsRoot
    operation              = $operation
    preview_only           = $previewOnly
    repository_exists      = $isRepository
    existing_changes_count = $dirtyLines.Count
    branch                 = $currentBranch
    remote_configured      = -not [string]::IsNullOrWhiteSpace($RemoteUrl)
    knowledge_mode         = if ([string]::IsNullOrWhiteSpace($RemoteUrl)) { 'local_only' } else { 'private_remote' }
    remote_checked         = $remoteChecked
    remote_reachable       = $remoteReachable
    remote_has_refs        = $remoteHasRefs
    credential_helper      = @($credentialHelpers)
    roots_persisted        = $false
    routing_policy         = (Join-Path $KnowledgePath '.ai\knowledge-routing.json')
    scaffold_created       = @()
    committed              = $false
    pushed                 = $false
}

Write-WizardStatus 'PLAN' "Knowledge path: $KnowledgePath"
Write-WizardStatus 'PLAN' "Operation: $operation"
if ($dirtyLines.Count -gt 0) {
    Write-WizardStatus 'PRESERVE' "Existing repository has $($dirtyLines.Count) uncommitted change(s); none will be staged or modified."
}
if (-not [string]::IsNullOrWhiteSpace($RemoteUrl)) {
    Write-WizardStatus 'AUTH' 'Authentication stays in Git Credential Manager or SSH; EggR does not accept or store tokens.'
}
Write-WizardStatus 'SAFETY' 'No commit, pull, branch switch, or push will run.'

if ($previewOnly) {
    Write-WizardStatus 'WHATIF' 'Validation completed; no files or Git configuration were changed.'
    if ($Json) {
        $diagnostic | ConvertTo-Json -Depth 5
    } else {
        Write-Output ([PSCustomObject]$diagnostic)
    }
    return
}

if ($operation -eq 'clone') {
    $parent = Split-Path -Parent $KnowledgePath
    if (-not (Test-Path -LiteralPath $parent)) {
        if ($PSCmdlet.ShouldProcess($parent, 'Create Knowledge parent directory')) {
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
        }
    }
    if ($PSCmdlet.ShouldProcess($KnowledgePath, 'Clone the user-owned private Knowledge repository')) {
        Invoke-GitCapture -Arguments @('clone', '--', $RemoteUrl, $KnowledgePath) | Out-Null
    }
} elseif ($operation -eq 'initialize') {
    if (-not (Test-Path -LiteralPath $KnowledgePath)) {
        if ($PSCmdlet.ShouldProcess($KnowledgePath, 'Create Knowledge directory')) {
            New-Item -ItemType Directory -Force -Path $KnowledgePath | Out-Null
        }
    }
    if ($PSCmdlet.ShouldProcess($KnowledgePath, "Initialize Git repository with '$DefaultBranch' as its unborn branch")) {
        $initResult = Invoke-GitCapture -Arguments @('init', '-b', $DefaultBranch, '--', $KnowledgePath) -AllowFailure
        if ($initResult.ExitCode -ne 0) {
            Invoke-GitCapture -Arguments @('init', '--', $KnowledgePath) | Out-Null
            Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'symbolic-ref', 'HEAD', "refs/heads/$DefaultBranch") | Out-Null
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $KnowledgePath '.git'))) {
    throw "Knowledge repository was not available after setup: $KnowledgePath"
}

if ($PSCmdlet.ShouldProcess($KnowledgePath, 'Set repository-local Git author identity')) {
    Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'config', '--local', 'user.name', $AuthorName) | Out-Null
    Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'config', '--local', 'user.email', $AuthorEmail) | Out-Null
}

$originAfterSetup = Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'remote', 'get-url', 'origin') -AllowFailure
if (-not [string]::IsNullOrWhiteSpace($RemoteUrl) -and $originAfterSetup.ExitCode -ne 0) {
    if ($PSCmdlet.ShouldProcess($KnowledgePath, 'Add private Knowledge origin')) {
        Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'remote', 'add', 'origin', $RemoteUrl) | Out-Null
    }
}

$worklogPath = Join-Path $KnowledgePath '00 Inbox\Agent Worklog.md'
if (-not (Test-Path -LiteralPath $worklogPath -PathType Leaf)) {
    if ($PSCmdlet.ShouldProcess($worklogPath, 'Create initial agent worklog')) {
        $worklogDirectory = Split-Path -Parent $worklogPath
        New-Item -ItemType Directory -Force -Path $worklogDirectory | Out-Null
        $initialWorklog = @'
# Agent Worklog

> 에이전트 작업의 중앙 감사 기록입니다. 비밀, 토큰, 비밀번호, 원문 대화는 기록하지 않습니다.

'@
        [IO.File]::WriteAllText($worklogPath, $initialWorklog, (New-Object Text.UTF8Encoding($false)))
    }
}

$scaffoldCreated = @(Initialize-KnowledgeScaffold -Root $KnowledgePath)
$diagnostic['scaffold_created'] = @($scaffoldCreated | ForEach-Object {
    $_.Substring($KnowledgePath.Length).TrimStart('\', '/')
})

if (-not $SkipRootPersistence) {
    if (-not (Test-Path -LiteralPath $rootSetter -PathType Leaf)) {
        throw "EggR root setter was not found beside this wizard: $rootSetter"
    }
    $setterArguments = @{
        WorkRoot     = $WorkRoot
        ToolsRoot    = $ToolsRoot
        Knowledge    = $KnowledgePath
        KnowledgeMode = if ([string]::IsNullOrWhiteSpace($RemoteUrl)) { 'local_only' } else { 'private_remote' }
    }
    if ([string]::IsNullOrWhiteSpace($RemoteUrl)) {
        $setterArguments['ClearKnowledgeRemote'] = $true
    } else {
        $setterArguments['KnowledgeRemote'] = $RemoteUrl
    }
    if ($PSCmdlet.ShouldProcess([string]$roots.ConfigFile, 'Persist Knowledge path and remote choice')) {
        & $rootSetter @setterArguments | Out-Null
        $diagnostic['roots_persisted'] = $true
    }
}

$finalStatus = Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'status', '--porcelain')
$finalBranch = Invoke-GitCapture -Arguments @('-C', $KnowledgePath, 'branch', '--show-current') -AllowFailure
$diagnostic['repository_exists'] = $true
$diagnostic['existing_changes_count'] = $finalStatus.Output.Count
$diagnostic['branch'] = ([string]($finalBranch.Output -join '')).Trim()

Write-WizardStatus 'OK' 'User-owned Knowledge repository is configured.'
Write-WizardStatus 'NEXT' 'Review the Obsidian routes, keep Knowledge on main, and save only explicitly routed files with save-knowledge.'
if ($Json) {
    $diagnostic | ConvertTo-Json -Depth 5
} else {
    Write-Output ([PSCustomObject]$diagnostic)
}
