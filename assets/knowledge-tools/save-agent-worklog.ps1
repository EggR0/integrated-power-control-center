<#
.SYNOPSIS
    Saves the central Agent Worklog to canonical Knowledge main.
.DESCRIPTION
    Delegates to save-knowledge.ps1 with the single fixed Worklog path. It does
    not create or reuse task-named branches.
#>
[CmdletBinding()]
param(
    [string]$Message = 'Update agent worklog',
    [string]$AuthorName = '',
    [string]$AuthorEmail = '',
    [switch]$NoPush
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$saveKnowledge = Join-Path $PSScriptRoot 'save-knowledge.ps1'
if (-not (Test-Path -LiteralPath $saveKnowledge -PathType Leaf)) {
    throw "save-knowledge.ps1 was not found beside this command: $saveKnowledge"
}

& $saveKnowledge `
    -Path '00 Inbox/Agent Worklog.md' `
    -Message $Message `
    -AuthorName $AuthorName `
    -AuthorEmail $AuthorEmail `
    -NoPush:$NoPush
