Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-True {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

$scriptPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\Invoke-LocalLLM.ps1"))
$artifactModulePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\lib\IntegratedPower.Artifacts.psm1"))
Import-Module $artifactModulePath -Force -DisableNameChecking
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "integrated-power-invoke-test-$([guid]::NewGuid().ToString('N'))"
$capturePath = Join-Path $testRoot "generate-request.json"
$requestLogPath = Join-Path $testRoot "requests.txt"
$settingsPath = Join-Path $testRoot "orchestrator.json"
$brainSession = Join-Path $testRoot ".gemini\antigravity-ide\brain\11111111-1111-1111-1111-111111111111"
$requestedOutputPath = Join-Path $brainSession "scratch\response_first.txt"
$coalescedOutputPath = Join-Path $brainSession "ip-orchestrator.md"
$stateRoot = Join-Path $testRoot "state"
$serverJob = $null
$previousSettingsPath = $env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS
$previousStateRoot = $env:INTEGRATED_POWER_STATE_ROOT
$previousOllamaHost = $env:OLLAMA_HOST

New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$port = ([Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()
$endpoint = "http://127.0.0.1:$port"

$settings = [ordered]@{
    SchemaVersion = 3
    EnabledRoutes = @("local_llm")
    DefaultRoute = "local_llm"
    LocalLlm = [ordered]@{
        Provider = "ollama"
        Endpoint = $endpoint
        Model = "test:model"
        HardwarePolicy = [ordered]@{
            Mode = "user_default"
            ReserveVramGB = 0
            AllowCpuOffload = $true
        }
    }
}
[IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))

try {
    $firstTarget = Resolve-IntegratedPowerArtifactTarget `
        -OutputFile (Join-Path $brainSession "scratch\response_first.txt") `
        -RepoRoot $testRoot `
        -StateRoot $stateRoot `
        -TaskKey "same-logical-task" `
        -TaskTitle "First title"
    $secondTarget = Resolve-IntegratedPowerArtifactTarget `
        -OutputFile (Join-Path $brainSession "scratch\response_second.txt") `
        -RepoRoot $testRoot `
        -StateRoot $stateRoot `
        -TaskKey "same-logical-task" `
        -TaskTitle "Second title"
    Assert-True ([string]$firstTarget.Path -eq [string]$secondTarget.Path) "Repeated requests in one brain session did not resolve to one artifact."
    Assert-True ((Split-Path -Leaf ([string]$firstTarget.Path)) -eq "ip-orchestrator.md") "The stable brain artifact has the wrong filename."

    Write-IntegratedPowerArtifact -Path $firstTarget.Path -Content "first" -Mode Replace -TaskTitle "First title" -Route "test"
    Write-IntegratedPowerArtifact -Path $secondTarget.Path -Content "second" -Mode Append -TaskTitle "Second title" -Route "test"
    $combinedArtifact = Get-Content -LiteralPath $firstTarget.Path -Raw
    Assert-True ($combinedArtifact.Contains("first") -and $combinedArtifact.Contains("second")) "Append mode did not preserve the prior task content."

    $defaultFirst = Resolve-IntegratedPowerArtifactTarget -RepoRoot $testRoot -StateRoot $stateRoot -TaskKey "same-logical-task" -TaskTitle "First title"
    $defaultSecond = Resolve-IntegratedPowerArtifactTarget -RepoRoot $testRoot -StateRoot $stateRoot -TaskKey "same-logical-task" -TaskTitle "Changed subtask title"
    Assert-True ([string]$defaultFirst.Path -eq [string]$defaultSecond.Path) "A reused TaskKey should keep the same default state artifact path."

    $serverJob = Start-Job -ScriptBlock {
        param($Prefix, $CapturePath, $RequestLogPath)

        $listener = [Net.HttpListener]::new()
        $listener.Prefixes.Add("$($Prefix.TrimEnd('/'))/")
        $listener.Start()
        try {
            for ($requestIndex = 0; $requestIndex -lt 3; $requestIndex++) {
                $context = $listener.GetContext()
                $requestPath = $context.Request.Url.AbsolutePath
                [IO.File]::AppendAllText($RequestLogPath, "$requestPath`r`n")

                switch ($requestPath) {
                    "/api/version" {
                        $responseJson = '{"version":"test"}'
                    }
                    "/api/ps" {
                        $responseJson = '{"models":[]}'
                    }
                    "/api/generate" {
                        $reader = New-Object IO.StreamReader($context.Request.InputStream, $context.Request.ContentEncoding)
                        try {
                            $requestBody = $reader.ReadToEnd()
                        }
                        finally {
                            $reader.Dispose()
                        }
                        [IO.File]::WriteAllText($CapturePath, $requestBody, (New-Object Text.UTF8Encoding($false)))

                        # The normal timeout in the test is one second. This
                        # deliberate delay proves the cold-load timeout is used.
                        Start-Sleep -Seconds 2
                        $responseJson = '{"response":"mock result","eval_count":7,"prompt_eval_count":5}'
                    }
                    default {
                        $context.Response.StatusCode = 404
                        $responseJson = '{"error":"unexpected path"}'
                    }
                }

                $bytes = [Text.Encoding]::UTF8.GetBytes($responseJson)
                $context.Response.ContentType = "application/json"
                $context.Response.ContentLength64 = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                $context.Response.OutputStream.Close()
            }
        }
        finally {
            $listener.Stop()
            $listener.Close()
        }
    } -ArgumentList $endpoint, $capturePath, $requestLogPath

    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            $client = New-Object Net.Sockets.TcpClient
            $client.Connect("127.0.0.1", $port)
            $client.Close()
            $ready = $true
            break
        }
        catch {
            Start-Sleep -Milliseconds 100
        }
    }
    Assert-True $ready "The fake Ollama server did not start."

    $env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS = $settingsPath
    $env:INTEGRATED_POWER_STATE_ROOT = $stateRoot
    Remove-Item Env:\OLLAMA_HOST -ErrorAction SilentlyContinue

    & $scriptPath `
        -PromptText "Return the mocked response without creating a prompt artifact." `
        -OutputFile $requestedOutputPath `
        -TaskKey "same-logical-task" `
        -Model "test:model" `
        -KeepAlive "45m" `
        -TimeoutSeconds 1 `
        -ColdLoadTimeoutSeconds 5 `
        -ConnectTimeoutSeconds 2

    Assert-True (Test-Path -LiteralPath $coalescedOutputPath -PathType Leaf) "The coalesced Antigravity artifact was not created."
    Assert-True (-not (Test-Path -LiteralPath $requestedOutputPath)) "A per-call response artifact was left in brain/scratch."
    Assert-True ((Get-Content -LiteralPath $coalescedOutputPath -Raw).Trim() -eq "mock result") "The mocked inference response was not written."
    $visibleArtifacts = @(Get-ChildItem -LiteralPath $brainSession -File -Recurse -ErrorAction SilentlyContinue)
    Assert-True ($visibleArtifacts.Count -eq 1) "The invocation should leave exactly one file in the Antigravity brain session."

    $capturedRequest = Get-Content -LiteralPath $capturePath -Raw | ConvertFrom-Json
    Assert-True ([string]$capturedRequest.model -eq "test:model") "The requested model was not preserved."
    Assert-True ([string]$capturedRequest.prompt -eq "Return the mocked response without creating a prompt artifact.") "PromptText was not sent directly."
    Assert-True ([string]$capturedRequest.keep_alive -eq "45m") "keep_alive was not sent in the generate request."
    Assert-True ([int]$capturedRequest.options.num_ctx -eq 4096) "num_ctx was not sent in the generate request."

    $requestPaths = @(Get-Content -LiteralPath $requestLogPath)
    Assert-True ($requestPaths.Count -eq 3) "The invoke script made an unexpected extra request."
    Assert-True (($requestPaths -join ",") -eq "/api/version,/api/ps,/api/generate") "The invoke sequence should check state and then send one real generation request without a warm-up."

    Write-Host "Invoke-LocalLLM.Tests.ps1 passed."
}
finally {
    $env:INTEGRATED_POWER_ORCHESTRATOR_SETTINGS = $previousSettingsPath
    $env:INTEGRATED_POWER_STATE_ROOT = $previousStateRoot
    if ($null -ne $previousOllamaHost) {
        $env:OLLAMA_HOST = $previousOllamaHost
    }
    else {
        Remove-Item Env:\OLLAMA_HOST -ErrorAction SilentlyContinue
    }

    if ($null -ne $serverJob) {
        if ($serverJob.State -eq "Running") {
            Stop-Job -Job $serverJob -ErrorAction SilentlyContinue
        }
        Remove-Job -Job $serverJob -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
