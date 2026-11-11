param(
    [string]$Target = 'gemini:antigravity',
    [string]$Email = '',
    [string]$AccessToken = '',
    [string]$RefreshToken = '',
    [int]$ExpiresIn = 3599,
    [string]$AuthMethod = 'consumer'
)
$ErrorActionPreference = 'Stop'

if (-not ('AgyCredWriter.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AgyCredWriter {
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

        [DllImport("Advapi32.dll", SetLastError = true)]
        public static extern void CredFree(IntPtr buffer);
    }
}
'@
}

$existingPayload = $null
$readPtr = [IntPtr]::Zero
if ([AgyCredWriter.NativeMethods]::CredRead($Target, 1, 0, [ref]$readPtr)) {
    try {
        $existingCred = [Runtime.InteropServices.Marshal]::PtrToStructure($readPtr, [type][AgyCredWriter.NativeMethods+Credential])
        $existingBytes = New-Object byte[] $existingCred.CredentialBlobSize
        [Runtime.InteropServices.Marshal]::Copy($existingCred.CredentialBlob, $existingBytes, 0, $existingBytes.Length)
        try {
            $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
            $existingVal = $utf8.GetString($existingBytes)
        } catch {
            $existingVal = [Text.Encoding]::Unicode.GetString($existingBytes)
        }
        $existingPayload = $existingVal | ConvertFrom-Json
    } catch {
        $existingPayload = $null
    } finally {
        [AgyCredWriter.NativeMethods]::CredFree($readPtr)
    }
}

$expiryIso = (Get-Date).ToUniversalTime().AddSeconds($ExpiresIn).ToString("yyyy-MM-ddTHH:mm:ssZ")
$tokenObj = [ordered]@{
    access_token = $AccessToken
    token_type = "Bearer"
    refresh_token = $RefreshToken
    expiry = $expiryIso
    expires_in = $ExpiresIn
}

$resolvedAuthMethod = $AuthMethod
if ($existingPayload -and $existingPayload.auth_method) {
    $resolvedAuthMethod = [string]$existingPayload.auth_method
}
$resolvedEmail = $Email
if (-not $resolvedEmail -and $existingPayload -and $existingPayload.id_token_email) {
    $resolvedEmail = [string]$existingPayload.id_token_email
}

$payloadObj = [ordered]@{
    token = $tokenObj
    auth_method = $resolvedAuthMethod
    id_token_email = $resolvedEmail
}
if ($existingPayload) {
    foreach ($prop in $existingPayload.PSObject.Properties) {
        if ($prop.Name -notin @('token', 'auth_method', 'id_token_email') -and $null -ne $prop.Value) {
            $payloadObj[$prop.Name] = $prop.Value
        }
    }
}

$json = $payloadObj | ConvertTo-Json -Compress -Depth 6
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)

try {
    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPtr, $bytes.Length)
    $cred = New-Object AgyCredWriter.NativeMethods+Credential
    $cred.Type = 1
    $cred.TargetName = $Target
    $cred.UserName = "antigravity"
    $cred.CredentialBlob = $blobPtr
    $cred.CredentialBlobSize = [uint32]$bytes.Length
    $cred.Persist = 2

    $ok = [AgyCredWriter.NativeMethods]::CredWrite([ref]$cred, 0)
    if (-not $ok) {
        throw "CredWrite failed for $Target"
    }
    Write-Output "Successfully wrote credential to $Target"
} finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
}
