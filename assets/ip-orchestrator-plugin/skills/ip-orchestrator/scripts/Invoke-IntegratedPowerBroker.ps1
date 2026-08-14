[CmdletBinding()]
param(
  [ValidateSet('health','capabilities','tasks','create','delegate','cancel')]
  [string]$Action = 'health',
  [int]$Port = 0,
  [string]$TaskId,
  [string]$Title,
  [string]$Goal,
  [string]$Provider = 'local.openai-compatible',
  [string]$Prompt,
  [string]$WorkspacePath,
  [string]$ConversationId,
  [int]$ExpectedRevision = 0,
  [switch]$AllowApiSpend
)

$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'IntegratedPower\broker.json'
if ($Port -le 0 -and (Test-Path -LiteralPath $state)) {
  try { $Port = [int](Get-Content -LiteralPath $state -Raw | ConvertFrom-Json).port } catch { $Port = 0 }
}
if ($Port -le 0) { $Port = 37241 }
$base = "http://127.0.0.1:$Port"

function Invoke-Broker([string]$Method, [string]$Path, [object]$Body = $null) {
  $params = @{ Method = $Method; Uri = "$base$Path"; TimeoutSec = 30 }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Depth 12 -Compress)
  }
  try { return Invoke-RestMethod @params }
  catch { throw "Integrated Power broker unavailable at $base. Start the broker from the Integrated Power extension first. $($_.Exception.Message)" }
}

switch ($Action) {
  'health' { Invoke-Broker 'GET' '/health' | ConvertTo-Json -Depth 8 }
  'capabilities' { Invoke-Broker 'GET' '/v1/capabilities' | ConvertTo-Json -Depth 12 }
  'tasks' { Invoke-Broker 'GET' '/v1/tasks' | ConvertTo-Json -Depth 12 }
  'create' {
    if ([string]::IsNullOrWhiteSpace($Title) -or [string]::IsNullOrWhiteSpace($Goal)) { throw 'Title and Goal are required for create.' }
    $body = @{ title = $Title; goal = $Goal; originProvider = $Provider; privacy = 'private'; budget = @{ maxParticipants = 4; allowApiSpend = [bool]$AllowApiSpend } }
    if ($WorkspacePath) { $body.workspacePath = $WorkspacePath }
    if ($ConversationId) { $body.linkedConversationId = $ConversationId }
    Invoke-Broker 'POST' '/v1/tasks' $body | ConvertTo-Json -Depth 12
  }
  'delegate' {
    if ([string]::IsNullOrWhiteSpace($TaskId) -or [string]::IsNullOrWhiteSpace($Prompt)) { throw 'TaskId and Prompt are required for delegate.' }
    Invoke-Broker 'POST' '/v1/tasks/delegate' @{ taskId = $TaskId; provider = $Provider; prompt = $Prompt; expectedRevision = $ExpectedRevision } | ConvertTo-Json -Depth 12
  }
  'cancel' {
    if ([string]::IsNullOrWhiteSpace($TaskId)) { throw 'TaskId is required for cancel.' }
    Invoke-Broker 'POST' "/v1/tasks/$TaskId/cancel" @{ expectedRevision = $ExpectedRevision } | ConvertTo-Json -Depth 12
  }
}
