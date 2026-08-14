import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

const SERVICE = "IntegratedPower";

/** Require a platform secret store; a legacy key is accepted only while it is
 * migrated into that store. Windows additionally uses user-scoped DPAPI. */
export function loadOrCreateLedgerKey(filePath: string): Buffer {
  const target = `${SERVICE}/${crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex")}`;
  const secure = readSecure(target);
  if (secure?.length === 32) return secure;
  const dpapi = readDpapi(`${filePath}.dpapi`);
  if (dpapi?.length === 32) return dpapi;
  try {
    const legacy = fs.readFileSync(filePath);
    if (legacy.length === 32) {
      if (writeSecure(target, legacy)) return legacy;
    }
  } catch { /* create below */ }
  const generated = crypto.randomBytes(32);
  if (!writeSecure(target, generated) && !writeDpapi(`${filePath}.dpapi`, generated)) throw new Error("No platform secure key store is available for the Integrated Power ledger.");
  return generated;
}

function readSecure(target: string): Buffer | undefined {
  if (process.env.INTEGRATED_POWER_DISABLE_KEYCHAIN === "1") return undefined;
  try {
    if (process.platform === "win32") {
      const value = runWindowsCredential("read", target);
      return value ? Buffer.from(value, "base64") : undefined;
    }
    if (process.platform === "darwin") {
      const value = execFileSync("security", ["find-generic-password", "-a", SERVICE, "-s", target, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return value ? Buffer.from(value, "base64") : undefined;
    }
    const value = execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", target], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return value ? Buffer.from(value, "base64") : undefined;
  } catch { return undefined; }
}

function writeSecure(target: string, value: Buffer): boolean {
  if (process.env.INTEGRATED_POWER_DISABLE_KEYCHAIN === "1") return false;
  const encoded = value.toString("base64");
  try {
    if (process.platform === "win32") {
      runWindowsCredential("write", target, encoded);
      return runWindowsCredential("read", target) === encoded;
    }
    if (process.platform === "darwin") {
      execFileSync("security", ["add-generic-password", "-U", "-a", SERVICE, "-s", target, "-w", encoded], { stdio: "ignore" });
      return true;
    }
    execFileSync("secret-tool", ["store", "--label", "Integrated Power ledger key", "service", SERVICE, "account", target], { input: encoded, stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch { return false; }
}

function readDpapi(filePath: string): Buffer | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const output = runPowerShell(String.raw`
Add-Type -AssemblyName System.Security
$bytes = [IO.File]::ReadAllBytes($env:INTEGRATED_POWER_DPAPI_PATH.Trim())
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`, { INTEGRATED_POWER_DPAPI_PATH: filePath });
    return output ? Buffer.from(output, "base64") : undefined;
  } catch { return undefined; }
}

function writeDpapi(filePath: string, value: Buffer): boolean {
  if (process.platform !== "win32") return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    runPowerShell(String.raw`
Add-Type -AssemblyName System.Security
$plain = [Convert]::FromBase64String($env:INTEGRATED_POWER_DPAPI_VALUE)
$protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($env:INTEGRATED_POWER_DPAPI_PATH.Trim(), $protected)
`, { INTEGRATED_POWER_DPAPI_PATH: filePath, INTEGRATED_POWER_DPAPI_VALUE: value.toString("base64") });
    return readDpapi(filePath)?.equals(value) ?? false;
  } catch { return false; }
}

function runPowerShell(script: string, variables: Record<string, string>): string {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
    env: { ...process.env, ...variables },
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function runWindowsCredential(operation: "read" | "write", target: string, value?: string): string {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IntegratedPowerCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; [MarshalAs(UnmanagedType.LPWStr)] public string TargetName; [MarshalAs(UnmanagedType.LPWStr)] public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias; [MarshalAs(UnmanagedType.LPWStr)] public string UserName; }
  [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr credential);
  public static string Read(string target) { IntPtr ptr; if (!CredRead(target, 1, 0, out ptr)) return ""; try { var c = Marshal.PtrToStructure<CREDENTIAL>(ptr); if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return ""; var bytes = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length); return Convert.ToBase64String(bytes); } finally { CredFree(ptr); } }
  public static void Write(string target, string value) { var bytes = Convert.FromBase64String(value); var blob = Marshal.AllocCoTaskMem(bytes.Length); try { Marshal.Copy(bytes, 0, blob, bytes.Length); var c = new CREDENTIAL { Type = 1, TargetName = target, CredentialBlob = blob, CredentialBlobSize = (UInt32)bytes.Length, Persist = 2, UserName = "IntegratedPower" }; if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } finally { Marshal.FreeCoTaskMem(blob); } }
}
'@
if ($env:INTEGRATED_POWER_CREDENTIAL_OPERATION -eq 'read') { [Console]::Out.Write([IntegratedPowerCredential]::Read($env:INTEGRATED_POWER_CREDENTIAL_TARGET)) }
else { [IntegratedPowerCredential]::Write($env:INTEGRATED_POWER_CREDENTIAL_TARGET, $env:INTEGRATED_POWER_CREDENTIAL_VALUE); [Console]::Out.Write('OK') }
`;
  return runPowerShell(script, { INTEGRATED_POWER_CREDENTIAL_OPERATION: operation, INTEGRATED_POWER_CREDENTIAL_TARGET: target, INTEGRATED_POWER_CREDENTIAL_VALUE: value ?? "" });
}
