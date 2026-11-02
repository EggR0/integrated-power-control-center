$ErrorActionPreference = 'Stop'
param(
    [string]$Target = 'gemini:antigravity'
)

if (-not ('AgyCredentialReader.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AgyCredentialReader {
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

$pointer = [IntPtr]::Zero
$ok = [AgyCredentialReader.NativeMethods]::CredRead($Target, 1, 0, [ref]$pointer)
if (-not $ok) {
    throw "The agy credential for target '$Target' was not found. Run agy and sign in once."
}

try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
        $pointer,
        [type][AgyCredentialReader.NativeMethods+Credential]
    )
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)

    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $value = $utf8.GetString($bytes)
    }
    catch {
        $value = [Text.Encoding]::Unicode.GetString($bytes)
    }

    # If reading the default target, automatically preserve an account-specific copy
    if ($Target -eq 'gemini:antigravity') {
        try {
            $parsed = $value | ConvertFrom-Json
            if ($parsed.id_token_email) {
                $specificTarget = "gemini:antigravity:$($parsed.id_token_email)"
                $blobBytes = [System.Text.Encoding]::UTF8.GetBytes($value)
                $blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($blobBytes.Length)
                try {
                    [System.Runtime.InteropServices.Marshal]::Copy($blobBytes, 0, $blobPtr, $blobBytes.Length)
                    $c = New-Object AgyCredentialReader.NativeMethods+Credential
                    $c.Type = 1
                    $c.TargetName = $specificTarget
                    $c.UserName = "antigravity"
                    $c.CredentialBlob = $blobPtr
                    $c.CredentialBlobSize = [uint32]$blobBytes.Length
                    $c.Persist = 2
                    $null = [AgyCredentialReader.NativeMethods]::CredWrite([ref]$c, 0)
                } finally {
                    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
                }
            }
        } catch {}
    }

    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    [Console]::Out.Write($value)
}
finally {
    [AgyCredentialReader.NativeMethods]::CredFree($pointer)
}
