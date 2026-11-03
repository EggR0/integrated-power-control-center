$ErrorActionPreference = 'Stop'

if (-not ('AgyMultiCredCollector.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AgyMultiCredCollector {
    public static class NativeMethods {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct Credential {
            public UInt32 Flags;
            public UInt32 Type;
            public string TargetName;
            public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public UInt32 CredentialBlobSize;
            public IntPtr CredentialBlob;
            public UInt32 Persist;
            public UInt32 AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias;
            public string UserName;
        }

        [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);

        [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredWrite(ref Credential credential, UInt32 flags);

        [DllImport("Advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredEnumerate(string filter, UInt32 flags, out UInt32 count, out IntPtr credentialPtrArray);

        [DllImport("Advapi32.dll", SetLastError = true)]
        public static extern void CredFree(IntPtr buffer);
    }
}
'@
}

function Read-Cred([string]$target) {
    $ptr = [IntPtr]::Zero
    if ([AgyMultiCredCollector.NativeMethods]::CredRead($target, 1, 0, [ref]$ptr)) {
        try {
            $c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AgyMultiCredCollector.NativeMethods+Credential])
            $bytes = New-Object byte[] $c.CredentialBlobSize
            [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $bytes.Length)
            try {
                $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
                $val = $utf8.GetString($bytes)
            } catch {
                $val = [Text.Encoding]::Unicode.GetString($bytes)
            }
            return @{
                Target = $target
                UserName = $c.UserName
                Value = $val
            }
        } finally {
            [AgyMultiCredCollector.NativeMethods]::CredFree($ptr)
        }
    }
    return $null
}

function Write-Cred([string]$target, [string]$userName, [string]$value) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($value)
    $blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    try {
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPtr, $bytes.Length)
        $cred = New-Object AgyMultiCredCollector.NativeMethods+Credential
        $cred.Type = 1
        $cred.TargetName = $target
        $cred.UserName = $userName
        $cred.CredentialBlob = $blobPtr
        $cred.CredentialBlobSize = [uint32]$bytes.Length
        $cred.Persist = 2
        return [AgyMultiCredCollector.NativeMethods]::CredWrite([ref]$cred, 0)
    } finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
    }
}

$results = @{
    accounts = @{}
    gcpProjects = @{}
    activeIdeAccount = ""
}

# 1. Enumerate Windows Credential Manager
$count = 0
$ptrArray = [IntPtr]::Zero
if ([AgyMultiCredCollector.NativeMethods]::CredEnumerate("gemini:antigravity*", 0, [ref]$count, [ref]$ptrArray)) {
    try {
        for ($i = 0; $i -lt $count; $i++) {
            $credPtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptrArray, $i * [IntPtr]::Size)
            $c = [Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [type][AgyMultiCredCollector.NativeMethods+Credential])
            $target = $c.TargetName
            $data = Read-Cred $target
            if ($data -and $data.Value) {
                try {
                    $json = $data.Value | ConvertFrom-Json
                    $email = $json.id_token_email
                    if ($email) {
                        $results.accounts[$email] = @{
                            email = $email
                            source = "credential-manager"
                            target = $target
                            token = $json.token
                            auth_method = $json.auth_method
                        }
                        if ($target -eq 'gemini:antigravity') {
                            $null = Write-Cred "gemini:antigravity:$email" "antigravity" $data.Value
                        }
                    }
                } catch {}
            }
        }
    } finally {
        [AgyMultiCredCollector.NativeMethods]::CredFree($ptrArray)
    }
}

# 2. Check default target explicitly if not captured
if ($results.accounts.Count -eq 0) {
    $def = Read-Cred 'gemini:antigravity'
    if ($def -and $def.Value) {
        try {
            $j = $def.Value | ConvertFrom-Json
            if ($j.id_token_email) {
                $results.accounts[$j.id_token_email] = @{
                    email = $j.id_token_email
                    source = "credential-manager"
                    target = "gemini:antigravity"
                    token = $j.token
                    auth_method = $j.auth_method
                }
            }
        } catch {}
    }
}

# 3. Check Antigravity IDE state for active IDE account and live tokens
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$extractScript = Join-Path $scriptDir "extract-ide-auth.py"
if (Test-Path $extractScript) {
    try {
        $extractedRaw = python $extractScript 2>$null
        if ($extractedRaw) {
            $authObj = $extractedRaw | ConvertFrom-Json
            if ($authObj -and $authObj.email) {
                $results.activeIdeAccount = $authObj.email
                $ideEmail = $authObj.email
                
                # Check if specific target exists in Credential Manager
                $specCred = Read-Cred "gemini:antigravity:$ideEmail"
                if ($specCred -and $specCred.Value) {
                    try {
                        $j = $specCred.Value | ConvertFrom-Json
                        if ($j.token) {
                            if ($authObj.refresh_token -and -not $j.token.refresh_token) {
                                $j.token.refresh_token = $authObj.refresh_token
                            }
                            $results.accounts[$ideEmail] = @{
                                email = $ideEmail
                                source = "credential-manager"
                                target = "gemini:antigravity:$ideEmail"
                                token = $j.token
                                auth_method = $j.auth_method
                            }
                        }
                    } catch {}
                }
                
                if (-not $results.accounts.ContainsKey($ideEmail) -or -not $results.accounts[$ideEmail].token) {
                    $tokenObj = @{
                        access_token = $authObj.access_token
                        refresh_token = $authObj.refresh_token
                        token_type = "Bearer"
                        expiry = (Get-Date).ToUniversalTime().AddHours(1).ToString("yyyy-MM-ddTHH:mm:ssZ")
                    }
                    $results.accounts[$ideEmail] = @{
                        email = $ideEmail
                        source = "antigravity-ide-active"
                        target = "gemini:antigravity:$ideEmail"
                        token = $tokenObj
                        auth_method = "consumer"
                    }
                    $credPayload = @{
                        token = $tokenObj
                        auth_method = "consumer"
                        id_token_email = $ideEmail
                    } | ConvertTo-Json -Compress
                    $null = Write-Cred "gemini:antigravity:$ideEmail" "antigravity" $credPayload
                }
            }
        }
    } catch {}
}

# 4. Check ADC and agya GCP project
$adcPath = "$env:APPDATA\gcloud\application_default_credentials.json"
if (Test-Path $adcPath) {
    try {
        $adcRaw = [IO.File]::ReadAllText($adcPath)
        $adc = $adcRaw | ConvertFrom-Json
        $agyaCmd = "$env:LOCALAPPDATA\agy\bin\agya.cmd"
        $gcpProject = "project-cd8f7986-520d-4fbc-85f"
        if (Test-Path $agyaCmd) {
            $cmdText = [IO.File]::ReadAllText($agyaCmd)
            if ($cmdText -match 'GOOGLE_CLOUD_PROJECT=([^\r\n]+)') {
                $gcpProject = $matches[1].Trim().Trim('"', "'", ' ')
            }
        }
        $results.gcpProjects[$gcpProject] = @{
            projectId = $gcpProject
            label = "agya (Vertex AI)"
            authType = "adc"
            client_id = $adc.client_id
            client_secret = $adc.client_secret
            refresh_token = $adc.refresh_token
            models = @("gemini-4-argon-high", "gemini-2.0-flash", "gemini-1.5-pro")
        }
    } catch {}
}

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$results | ConvertTo-Json -Depth 6
