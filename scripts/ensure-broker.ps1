# Ensure Integrated Power Broker is running on 127.0.0.1:37241
$ErrorActionPreference = "SilentlyContinue"
$port = 37241
$alive = $false

try {
    $req = [System.Net.WebRequest]::Create("http://127.0.0.1:$port/health")
    $req.Timeout = 800
    $resp = $req.GetResponse()
    if ($resp.StatusCode -eq 200) {
        $alive = $true
    }
    $resp.Close()
} catch {
    $alive = $false
}

if (-not $alive) {
    $ipccDir = "D:\Workspace\integrated-power-control-center"
    $brokerScript = Join-Path $ipccDir "broker-server.js"
    $nodeExe = "node.exe"
    $nodeCmd = (Get-Command "node.exe" -ErrorAction SilentlyContinue).Source
    if (-not $nodeCmd) { $nodeCmd = "C:\Program Files\nodejs\node.exe" }
    $cmdLine = "`"$nodeCmd`" `"$brokerScript`""

    try {
        Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $cmdLine
            CurrentDirectory = $ipccDir
        } | Out-Null
    } catch {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $nodeCmd
        $psi.Arguments = "`"$brokerScript`""
        $psi.WorkingDirectory = $ipccDir
        $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $psi.CreateNoWindow = $true
        $psi.UseShellExecute = $true
        [System.Diagnostics.Process]::Start($psi) | Out-Null
    }

    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 300
        try {
            $req = [System.Net.WebRequest]::Create("http://127.0.0.1:$port/health")
            $req.Timeout = 500
            $resp = $req.GetResponse()
            if ($resp.StatusCode -eq 200) {
                $resp.Close()
                break
            }
            $resp.Close()
        } catch {}
    }
}

Write-Output "{}"
