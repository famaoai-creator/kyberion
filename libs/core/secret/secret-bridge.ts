/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { nowIso } from '../foundation/time.js';
import { getRegisteredEnvBool, getRegisteredEnvText, setRegisteredEnv } from '../foundation/env.js';
import { isMacOS, isWindows } from '../platform-facts.js';
import {
  safeChmodSync,
  safeExistsSync,
  safeLstat,
  safeWriteFile,
  safeMkdir,
  safeExecResult,
  withSensitivePathMediation,
} from '../secure-io.js';
import { SecretProvider, RegistryEntry } from './secret-types.js';
import {
  AWS_SECRETS_MANAGER_PROVIDER_ID,
  GCP_SECRET_MANAGER_PROVIDER_ID,
  HASHICORP_VAULT_PROVIDER_ID,
  ONEPASSWORD_PROVIDER_ID,
  createExternalSecretProviders,
} from './external-secret-providers.js';
import { keychainReaderAccessSwiftLines, keychainSwiftArgs } from './keychain-access.js';
import {
  memoizedNativeSecretRead,
  invalidateNativeSecretRead,
} from '../foundation/secret-resolution-session.js';
import { ProviderChainRouter } from '../provider/provider-chain-router.js';
import {
  listSecretProviders,
  registerSecretProvider,
  SECRET_PROVIDER_SEAM,
} from './provider-registry.js';

// Resolve vault/knowledge paths lazily so importing this module (via
// secret-guard fallthrough) does not require a fully-mocked pathResolver.
function keychainRegistryPath(): string {
  return pathResolver.vault('secrets/keychain-registry.json');
}
function fileSecretsPath(): string {
  return pathResolver.vault('secrets/file-secrets.json');
}
function keychainRegistrySchemaPath(): string {
  return pathResolver.knowledge('product/schemas/keychain-registry.schema.json');
}
function fileSecretsSchemaPath(): string {
  return pathResolver.knowledge('product/schemas/file-secrets.schema.json');
}

// Helper to manage the registry catalog
interface KeychainRegistry {
  entries: RegistryEntry[];
}

function keychainRegistryCatalog() {
  return defineCatalog<KeychainRegistry>({
    id: 'keychain-registry',
    path: keychainRegistryPath(),
    schema: keychainRegistrySchemaPath(),
  });
}

function fileSecretsCatalog(filePath: string) {
  return defineCatalog<Record<string, Record<string, string>>>({
    id: 'file-secrets',
    path: filePath,
    schema: fileSecretsSchemaPath(),
  });
}

function loadRegistry(): KeychainRegistry {
  return withSensitivePathMediation(() => {
    const registryPath = keychainRegistryPath();
    if (!safeExistsSync(registryPath)) return { entries: [] };
    try {
      return keychainRegistryCatalog().load();
    } catch {
      return { entries: [] };
    }
  });
}

function saveRegistry(registry: KeychainRegistry): void {
  withSensitivePathMediation(() => {
    const registryPath = keychainRegistryPath();
    const dir = path.dirname(registryPath);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    const validated = keychainRegistryCatalog().validate(registry, registryPath);
    safeWriteFile(registryPath, JSON.stringify(validated, null, 2));
  });
}

export function registryAdd(service: string, account: string): void {
  const registry = loadRegistry();
  const existing = registry.entries.findIndex(
    (e) => e.service === service && e.account === account
  );
  const entry: RegistryEntry = { service, account, addedAt: nowIso() };
  if (existing >= 0) {
    registry.entries[existing] = entry;
  } else {
    registry.entries.push(entry);
  }
  saveRegistry(registry);
}

export function registryRemove(service: string, account: string): void {
  const registry = loadRegistry();
  registry.entries = registry.entries.filter(
    (e) => !(e.service === service && e.account === account)
  );
  saveRegistry(registry);
}

/** Bound for keychain reads/deletes (`security`). */
export const KEYCHAIN_COMMAND_TIMEOUT_MS = 10_000;
/** Bound for keychain writes: `swift -e` compiles the helper before running it. */
export const KEYCHAIN_WRITE_TIMEOUT_MS = 60_000;

/**
 * Settle a keychain child exactly once: on 'close', on spawn 'error' (e.g.
 * the binary is missing — without a listener that crashes the process), or
 * when the kill timer fires (a locked keychain can prompt and hang forever).
 */
function superviseKeychainChild(
  child: ChildProcess,
  timeoutMs: number,
  onSettled: (outcome: { code: number | null; error?: Error }) => void
): void {
  let settled = false;
  const settle = (outcome: { code: number | null; error?: Error }): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onSettled(outcome);
  };
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    settle({ code: null, error: new Error(`timed out after ${timeoutMs}ms`) });
  }, timeoutMs);
  timer.unref?.();
  child.on('error', (error) => settle({ code: null, error }));
  child.on('close', (code) => settle({ code }));
}

/** Single-line service / account / value (never logged: the error names no value). */
function assertKeychainWritable(service: string, account: string, value: string): void {
  if (/[\r\n]/u.test(service) || /[\r\n]/u.test(account)) {
    throw new Error('macOS Keychain write refused: service and account must be single-line');
  }
  if (!value) throw new Error('macOS Keychain write refused: the value is empty');
  if (/[\r\n]/u.test(value)) {
    throw new Error(
      'macOS Keychain write refused: the value contains a line break, which the keychain reader cannot return intact | next: store it base64-encoded or as a file secret'
    );
  }
}

// 1. macOS Keychain native provider
export class MacKeychainSecretProvider implements SecretProvider {
  readonly id = 'mac_keychain';

  async isAvailable(): Promise<boolean> {
    return isMacOS();
  }

  async get(service: string, account: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(
        'security',
        ['find-generic-password', '-a', account, '-s', service, '-w'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      superviseKeychainChild(child, KEYCHAIN_COMMAND_TIMEOUT_MS, ({ code }) => {
        resolve(code === 0 && stdout.trim() ? stdout.trim() : null);
      });
    });
  }

  async set(service: string, account: string, value: string): Promise<void> {
    // The helper reads three stdin lines, and `security -w` returns a value
    // holding a newline hex-encoded, so such a value could never be read back:
    // refuse it here, before the existing entry is touched.
    assertKeychainWritable(service, account, value);
    // An existing item keeps whatever ACL it was created with (SecItemUpdate
    // never changes it), and only a binary that item trusts may delete it. The
    // trusted reader (`security`) removes it first; refusal leaves it intact.
    await this.removeBeforeWrite(service, account);

    // Write via a short-lived Swift helper that reads service/account/value from
    // stdin — never place the secret on process argv (unlike `security -w`). The
    // item trusts the reader so later non-interactive reads need no prompt.
    // Exit codes: 2 bad stdin, 3 empty value, 4/5 access object, 6 delete
    // refused, 7 add failed (the OSStatus goes to stderr).
    const script = [
      'import Foundation',
      'import Security',
      'func fail(_ step: String, _ status: OSStatus, _ code: Int32) -> Never {',
      '  FileHandle.standardError.write("\\(step) failed: OSStatus \\(status)\\n".data(using: .utf8)!)',
      '  exit(code)',
      '}',
      'guard let service = readLine(), let account = readLine(), let password = readLine() else { exit(2) }',
      'guard let passwordData = password.data(using: .utf8), !passwordData.isEmpty else { exit(3) }',
      ...keychainReaderAccessSwiftLines(),
      'let query: [String: Any] = [',
      '  kSecClass as String: kSecClassGenericPassword,',
      '  kSecAttrService as String: service,',
      '  kSecAttrAccount as String: account,',
      ']',
      'var add = query',
      'add[kSecValueData as String] = passwordData',
      'add[kSecAttrAccess as String] = access',
      'var status = SecItemAdd(add as CFDictionary, nil)',
      'if status == errSecDuplicateItem {',
      '  // Re-created concurrently: replace it so the item carries the reader ACL.',
      '  let removed = SecItemDelete(query as CFDictionary)',
      '  if removed != errSecSuccess && removed != errSecItemNotFound { fail("SecItemDelete", removed, 6) }',
      '  status = SecItemAdd(add as CFDictionary, nil)',
      '}',
      'if status != errSecSuccess { fail("SecItemAdd", status, 7) }',
      'exit(0)',
    ].join('\n');

    return new Promise((resolve, reject) => {
      const child = spawn('swift', keychainSwiftArgs(script), {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      superviseKeychainChild(child, KEYCHAIN_WRITE_TIMEOUT_MS, ({ code, error }) => {
        // Any previous entry is already gone: keep the registry and read cache
        // honest, and say so, so the operator re-runs the write.
        invalidateNativeSecretRead(service, account);
        // The entry is gone, so the registry must not keep listing it.
        let registryNote = '';
        if (error || code !== 0) {
          try {
            registryRemove(service, account);
          } catch (registryError) {
            registryNote = `; the registry still lists it (${registryError instanceof Error ? registryError.message : String(registryError)})`;
          }
        }
        if (error) {
          reject(
            new Error(
              `macOS Keychain write failed: ${error.message} (any previous entry was removed; re-run the write)${registryNote}`
            )
          );
        } else if (code === 0) {
          try {
            invalidateNativeSecretRead(service, account);
            registryAdd(service, account);
            resolve();
          } catch (registryError) {
            reject(registryError);
          }
        } else {
          reject(
            new Error(
              `macOS Keychain write failed with code ${code} (any previous entry was removed; re-run the write)${registryNote}: ${stderr}`
            )
          );
        }
      });
      // A child that dies before reading stdin must not crash the caller (EPIPE).
      child.stdin?.on('error', () => undefined);
      child.stdin?.write(`${service}\n${account}\n${value}`);
      child.stdin?.end();
    });
  }

  /** Delete an existing item with the trusted reader; a miss (44) is fine. */
  private removeBeforeWrite(service: string, account: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('security', ['delete-generic-password', '-a', account, '-s', service], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      superviseKeychainChild(child, KEYCHAIN_COMMAND_TIMEOUT_MS, ({ code, error }) => {
        if (error || (code !== 0 && code !== 44)) {
          reject(
            new Error(
              `macOS Keychain write refused: the existing entry could not be replaced (${error ? error.message : `code ${code}`}); entry unchanged`
            )
          );
          return;
        }
        resolve();
      });
    });
  }

  async delete(service: string, account: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('security', ['delete-generic-password', '-a', account, '-s', service], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      superviseKeychainChild(child, KEYCHAIN_COMMAND_TIMEOUT_MS, ({ code, error }) => {
        if (error || (code !== 0 && code !== 44)) {
          reject(new Error('macOS Keychain deletion refused or unavailable; registry unchanged'));
          return;
        }
        try {
          invalidateNativeSecretRead(service, account);
          registryRemove(service, account);
          resolve();
        } catch (registryError) {
          reject(registryError);
        }
      });
    });
  }
}

// Windows Credential Manager provider. The Win32 CredRead/CredWrite APIs are
// hosted in a short-lived PowerShell process so Node never needs to load a
// platform-specific native module. Values are sent over stdin, never argv.
export class WindowsCredentialManagerSecretProvider implements SecretProvider {
  readonly id = 'windows_credential_manager';

  async isAvailable(): Promise<boolean> {
    return isWindows();
  }

  private run(
    operation: 'get' | 'set' | 'delete',
    service: string,
    account: string,
    value?: string
  ) {
    const target = windowsCredentialTarget(service, account);
    const script = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct KCredential {
  public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
  public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
}
public static class KCredentialApi {
  [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref KCredential credential, uint flags);
  [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = [string]$payload.target
$account = [string]$payload.account
$legacyTarget = [string]$payload.legacyTarget
$value = [string]$payload.value
function Get-OwnedCredentialValue([string]$credentialTarget) {
  $ptr = [IntPtr]::Zero
  if (-not [KCredentialApi]::CredRead($credentialTarget, 1, 0, [ref]$ptr)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 1168) { return $null }
    Write-Error "Credential Manager read failed with Win32 error $errorCode"
    exit 3
  }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][KCredential])
    if (-not [string]::Equals([string]$cred.UserName, $account, [StringComparison]::Ordinal)) { return $null }
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    if ($bytes.Length -gt 0) {
      [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $bytes.Length)
      return [Text.Encoding]::UTF8.GetString($bytes)
    }
    return ''
  } finally { [KCredentialApi]::CredFree($ptr) }
}
function Remove-OwnedCredential([string]$credentialTarget) {
  $ptr = [IntPtr]::Zero
  if (-not [KCredentialApi]::CredRead($credentialTarget, 1, 0, [ref]$ptr)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    return ($errorCode -eq 1168)
  }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][KCredential])
    if (-not [string]::Equals([string]$cred.UserName, $account, [StringComparison]::Ordinal)) { return $true }
    return [KCredentialApi]::CredDelete($credentialTarget, 1, 0)
  } finally { [KCredentialApi]::CredFree($ptr) }
}
if ('${operation}' -eq 'get') {
  $secret = Get-OwnedCredentialValue $target
  if ($null -eq $secret -and $legacyTarget -ne $target) { $secret = Get-OwnedCredentialValue $legacyTarget }
  if ($null -eq $secret) { exit 2 }
  [Console]::Out.Write($secret)
  exit 0
}
if ('${operation}' -eq 'delete') {
  if (-not (Remove-OwnedCredential $target)) { exit 3 }
  if ($legacyTarget -ne $target -and -not (Remove-OwnedCredential $legacyTarget)) {
    Write-Warning 'The new credential was saved, but a matching legacy credential could not be removed.'
  }
  exit 0
}
$targetPtr = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($target)
$userPtr = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($account)
$bytes = [Text.Encoding]::UTF8.GetBytes($value)
$blobPtr = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPtr, $bytes.Length)
$cred = New-Object KCredential
$cred.Type = 1; $cred.TargetName = $targetPtr; $cred.UserName = $userPtr
$cred.CredentialBlob = $blobPtr; $cred.CredentialBlobSize = $bytes.Length; $cred.Persist = 2
try {
  if (-not [KCredentialApi]::CredWrite([ref]$cred, 0)) { exit 2 }
  if ($legacyTarget -ne $target -and -not (Remove-OwnedCredential $legacyTarget)) { exit 3 }
}
finally {
  [Runtime.InteropServices.Marshal]::FreeCoTaskMem($targetPtr)
  [Runtime.InteropServices.Marshal]::FreeCoTaskMem($userPtr)
  [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blobPtr)
}
`;
    const input = JSON.stringify({ target, legacyTarget: service, account, value: value ?? '' });
    return safeExecResult('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeoutMs: 10_000,
      maxOutputMB: 2,
      input,
    });
  }

  getSync(service: string, account: string): string | null {
    if (!isWindows()) return null;
    return memoizedNativeSecretRead(service, account, () => {
      const result = this.run('get', service, account);
      return result.status === 0 && result.stdout.length > 0 ? result.stdout : null;
    });
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.getSync(service, account);
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const result = this.run('set', service, account, value);
    if (result.status !== 0)
      throw new Error(`Windows Credential Manager write failed: ${result.stderr || result.status}`);
    invalidateNativeSecretRead(service, account);
    registryAdd(service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    const result = this.run('delete', service, account);
    if (result.status !== 0 && result.status !== 2)
      throw new Error(
        `Windows Credential Manager delete failed: ${result.stderr || result.status}`
      );
    invalidateNativeSecretRead(service, account);
    registryRemove(service, account);
  }
}

function windowsCredentialTarget(service: string, account: string): string {
  const digest = createHash('sha256').update(service).update('\0').update(account).digest('hex');
  return `Kyberion.Secret.v1.${digest}`;
}

// 2. Local File Secret Provider (Fallback for Headless Linux/Windows)
const FORBIDDEN_SECRET_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeSecretMapKey(key: string, label: 'service' | 'account'): void {
  if (
    key === '__proto__' ||
    key === 'constructor' ||
    key === 'prototype' ||
    FORBIDDEN_SECRET_MAP_KEYS.has(key)
  ) {
    throw new Error(`[SECRET_BRIDGE_INVALID_KEY] ${label} may not be '${key}'`);
  }
}

export class FileSecretProvider implements SecretProvider {
  readonly id = 'file_secrets';

  constructor(private readonly secretsPath = fileSecretsPath()) {}

  async isAvailable(): Promise<boolean> {
    // Opt-in only. Never a silent default on darwin/win32 (keychain wins first
    // anyway) and never an implicit Linux store without operator acknowledgement.
    return getRegisteredEnvBool('KYBERION_ALLOW_FILE_SECRETS') === true;
  }

  private readSecretsFile(): Record<string, Record<string, string>> {
    return withSensitivePathMediation(() => {
      if (!safeExistsSync(this.secretsPath)) return {};
      this.assertNotSymlink(this.secretsPath, 'secret file');
      try {
        return fileSecretsCatalog(this.secretsPath).load();
      } catch {
        return {};
      }
    });
  }

  private writeSecretsFile(secrets: Record<string, Record<string, string>>): void {
    withSensitivePathMediation(() => {
      const dir = path.dirname(this.secretsPath);
      if (safeExistsSync(dir)) {
        this.assertNotSymlink(dir, 'secret directory');
      } else {
        safeMkdir(dir, { recursive: true, mode: 0o700 });
      }
      safeChmodSync(dir, 0o700);
      if (safeExistsSync(this.secretsPath)) {
        this.assertNotSymlink(this.secretsPath, 'secret file');
      }
      const validated = fileSecretsCatalog(this.secretsPath).validate(secrets, this.secretsPath);
      safeWriteFile(this.secretsPath, JSON.stringify(validated, null, 2), { mode: 0o600 });
      // Also repair permissions of files created by older versions.
      safeChmodSync(this.secretsPath, 0o600);
    });
  }

  private assertNotSymlink(targetPath: string, label: string): void {
    if (safeLstat(targetPath).isSymbolicLink()) {
      throw new Error(`[SECURITY] Refusing ${label} symbolic link: ${targetPath}`);
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    const secrets = this.readSecretsFile();
    return secrets[service]?.[account] || null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    // Prototype-pollution guard: secret names must never mutate the
    // prototype chain of the in-memory secrets map.
    assertSafeSecretMapKey(service, 'service');
    assertSafeSecretMapKey(account, 'account');
    if (
      service === '__proto__' ||
      account === '__proto__' ||
      service === 'constructor' ||
      account === 'constructor' ||
      service === 'prototype' ||
      account === 'prototype'
    ) {
      throw new Error('[SECRET_BRIDGE_INVALID_KEY] service/account may not be a prototype key');
    }
    const secrets = this.readSecretsFile();
    if (!secrets[service]) secrets[service] = {};
    secrets[service][account] = value;
    this.writeSecretsFile(secrets);
    registryAdd(service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    assertSafeSecretMapKey(service, 'service');
    assertSafeSecretMapKey(account, 'account');
    const secrets = this.readSecretsFile();
    if (
      service === '__proto__' ||
      account === '__proto__' ||
      service === 'constructor' ||
      account === 'constructor' ||
      service === 'prototype' ||
      account === 'prototype'
    ) {
      throw new Error('[SECRET_BRIDGE_INVALID_KEY] service/account may not be a prototype key');
    }
    if (secrets[service]) {
      delete secrets[service][account];
      if (Object.keys(secrets[service]).length === 0) {
        delete secrets[service];
      }
      this.writeSecretsFile(secrets);
    }
    registryRemove(service, account);
  }
}

// 3. Environment Variable Secret Provider
export class EnvSecretProvider implements SecretProvider {
  readonly id = 'env_secrets';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private envKey(service: string, account: string): string {
    return `SECRET_${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${account.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    const key = this.envKey(service, account);
    return getRegisteredEnvText(key) || null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const key = this.envKey(service, account);
    setRegisteredEnv(key, value);
    registryAdd(service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    const key = this.envKey(service, account);
    setRegisteredEnv(key, undefined);
    registryRemove(service, account);
  }
}

// Provider ordering runs through the shared ProviderChainRouter:
// `isAvailable()` is the hard eligibility filter; the baseline chain comes from
// the seam policy's `default_chains` (secret-provider.json) with this constant
// as the hermetic fallback.
const SECRET_BUILTIN_ORDER = [
  // External managers are opt-in (unavailable until configured) and, once
  // configured, take precedence over the local stores.
  HASHICORP_VAULT_PROVIDER_ID,
  AWS_SECRETS_MANAGER_PROVIDER_ID,
  GCP_SECRET_MANAGER_PROVIDER_ID,
  ONEPASSWORD_PROVIDER_ID,
  'mac_keychain',
  'windows_credential_manager',
  'file_secrets',
  'env_secrets',
] as const;

/**
 * Resolve the first available provider from `providers` through the governed
 * secret-provider chain. Exported for callers composing a custom provider set
 * outside the global registry (tests, one-off bridges).
 */
export async function selectSecretProvider(
  providers: readonly SecretProvider[]
): Promise<SecretProvider> {
  const router = new ProviderChainRouter<SecretProvider, Record<string, never>>(providers, {
    seam: SECRET_PROVIDER_SEAM,
    label: '[secret_bridge]',
    errorTag: '[SECRET_PROVIDER_SELECTION]',
    eligibility: async () =>
      Promise.all(
        providers.map(async (provider) => {
          const eligible = await provider.isAvailable();
          return {
            id: provider.id,
            eligible,
            ...(eligible ? {} : { unmet: ['backend isAvailable() is false'] }),
          };
        })
      ),
    builtinDefaultOrder: () => SECRET_BUILTIN_ORDER,
  });
  const [provider] = await router.resolveProviderChain({});
  if (!provider) throw new Error('No available Secret Provider resolved.');
  return provider;
}

let builtinProvidersRegistered = false;

/** Idempotent — the builtin set self-registers on import like other seams. */
export function registerBuiltinSecretProviders(): void {
  if (builtinProvidersRegistered) return;
  builtinProvidersRegistered = true;
  for (const provider of [
    new MacKeychainSecretProvider(),
    new WindowsCredentialManagerSecretProvider(),
    new FileSecretProvider(),
    new EnvSecretProvider(),
    ...createExternalSecretProviders(),
  ]) {
    registerSecretProvider(provider, { provenance: 'builtin', source: 'secret-bridge' });
  }
}

registerBuiltinSecretProviders();

export async function fetchSecret(service: string, account: string): Promise<string | null> {
  const provider = await selectSecretProvider(listSecretProviders());
  return await provider.get(service, account);
}

/**
 * Synchronous read of the OS keychain only (macOS login keychain; null on
 * other platforms or on a miss). Unlike {@link fetchSecretSync} it never falls
 * through to the in-repo file vault or SECRET_* env, so a caller can require
 * that a value lives outside the repository. Never logs the value.
 */
export function fetchOsKeychainSecretSync(service: string, account: string): string | null {
  if (!isMacOS()) return null;
  return memoizedNativeSecretRead(service, account, () => {
    const result = safeExecResult(
      'security',
      ['find-generic-password', '-a', account, '-s', service, '-w'],
      { timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS, maxOutputMB: 1 }
    );
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    return null;
  });
}

export type NativeSecretBackendId = 'os_keychain' | 'windows_credential_manager';

export interface NativeSecretRead {
  value: string;
  backend: NativeSecretBackendId;
}

/** Read only the current platform's OS-native secret store; never falls through to files or env. */
export function readNativeSecretSync(service: string, account: string): NativeSecretRead | null {
  if (isMacOS()) {
    const value = fetchOsKeychainSecretSync(service, account);
    return value ? { value, backend: 'os_keychain' } : null;
  }
  if (isWindows()) {
    const value = new WindowsCredentialManagerSecretProvider().getSync(service, account);
    return value ? { value, backend: 'windows_credential_manager' } : null;
  }
  return null;
}

/** Platform-neutral convenience wrapper for the OS-native secret store. */
export function fetchNativeSecretSync(service: string, account: string): string | null {
  return readNativeSecretSync(service, account)?.value ?? null;
}

/**
 * Synchronous lookup for secret-guard fallthrough. Prefer async {@link fetchSecret}
 * for new call sites. Never logs the value.
 */
export function fetchSecretSync(service: string, account: string): string | null {
  const nativeValue = fetchNativeSecretSync(service, account);
  if (nativeValue) return nativeValue;

  if (getRegisteredEnvBool('KYBERION_ALLOW_FILE_SECRETS') === true) {
    try {
      const provider = new FileSecretProvider();
      // FileSecretProvider.get is async but the body is sync I/O; drive via deasync-free path.
      const secrets = (
        provider as unknown as { readSecretsFile: () => Record<string, Record<string, string>> }
      ).readSecretsFile();
      const value = secrets[service]?.[account];
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      /* fall through */
    }
  }

  const envKey = `SECRET_${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${account.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return getRegisteredEnvText(envKey) || null;
}

export async function storeSecret(service: string, account: string, value: string): Promise<void> {
  const provider = await selectSecretProvider(listSecretProviders());
  await provider.set(service, account, value);
}

export async function removeSecret(service: string, account: string): Promise<void> {
  const provider = await selectSecretProvider(listSecretProviders());
  await provider.delete(service, account);
}

export function listSecrets(service?: string): { status: string; entries: RegistryEntry[] } {
  const registry = loadRegistry();
  const entries = service
    ? registry.entries.filter((e) => e.service === service)
    : registry.entries;
  return { status: 'success', entries };
}
