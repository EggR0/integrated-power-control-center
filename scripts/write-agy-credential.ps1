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

        [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredWrite(ref Credential credential, UInt32 flags);
    }
}
'@
}

$expiryIso = (Get-Date).ToUniversalTime().AddSeconds($ExpiresIn).ToString("yyyy-MM-ddTHH:mm:ssZ")
$tokenObj = @{
    access_token = $AccessToken
    refresh_token = $RefreshToken
    token_type = "Bearer"
    expires_in = $ExpiresIn
    expiry = $expiryIso
}

$payloadObj = @{
    token = $tokenObj
    auth_method = $AuthMethod
    id_token_email = $Email
}

$json = $payloadObj | ConvertTo-Json -Compress
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
