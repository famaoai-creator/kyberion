/**
 * DH-11: provider-neutral sandbox policy resolution.
 *
 * Permission presets describe intent; this module reports what the selected
 * provider can actually enforce. Callers that require a complete sandbox
 * must reject `partial` rather than treating a provider approximation as safe.
 */

import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxEnforcement = 'full' | 'partial';

export interface SandboxPolicyInput {
  mode: SandboxMode;
  networkAccess?: boolean;
  writableRoots?: readonly string[];
  provider?: 'codex' | 'claude' | 'agy' | 'grok' | 'gemini' | 'cursor' | 'opencode' | 'kyberion';
}

export interface SandboxPolicy {
  mode: SandboxMode;
  networkAccess: boolean;
  writableRoots?: readonly string[];
  provider: SandboxPolicyInput['provider'];
  enforcement: SandboxEnforcement;
  enforcement_reason: string;
}

const sandboxPolicyStorage = new AsyncLocalStorage<SandboxPolicy>();

/** Return the policy governing the current operation, when one was installed. */
export function getActiveSandboxPolicy(): SandboxPolicy | undefined {
  return sandboxPolicyStorage.getStore();
}

/**
 * Install one resolved policy around an operation. Low-level guards consume
 * this context so ADF, secure-io, and egress do not each invent a second
 * sandbox decision. The context is async-safe and nested calls inherit it.
 */
export function withSandboxPolicy<T>(policy: SandboxPolicy, fn: () => T): T {
  return sandboxPolicyStorage.run(policy, fn);
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

/** Apply the active policy to a local filesystem mutation. */
export function assertSandboxWriteAllowed(filePath: string): void {
  const policy = getActiveSandboxPolicy();
  if (!policy) return;
  if (policy.mode === 'read-only') {
    throw new Error(
      `[SANDBOX_WRITE_DENIED] ${policy.provider ?? 'unknown'} read-only sandbox denies writes: ${filePath}`
    );
  }
  if (
    policy.mode === 'workspace-write' &&
    policy.writableRoots?.length &&
    !policy.writableRoots.some((root) => isPathWithin(filePath, root))
  ) {
    throw new Error(
      `[SANDBOX_WRITE_DENIED] path is outside the active writable roots: ${filePath}`
    );
  }
}

/** Apply the active policy to a network request before URL/domain checks. */
export function assertSandboxNetworkAllowed(url?: string): void {
  const policy = getActiveSandboxPolicy();
  if (policy && !policy.networkAccess) {
    throw new Error(
      `[SANDBOX_NETWORK_DENIED] ${policy.provider ?? 'unknown'} sandbox denies network access${url ? `: ${url}` : ''}`
    );
  }
}

/** Resolve one canonical policy and its enforcement fact for all callers. */
export function resolveSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const provider = input.provider ?? 'kyberion';
  const networkAccess = input.networkAccess ?? false;
  const writableRoots = input.writableRoots?.length ? [...input.writableRoots] : undefined;

  if (input.mode === 'danger-full-access') {
    return {
      mode: input.mode,
      networkAccess,
      ...(writableRoots ? { writableRoots } : {}),
      provider,
      enforcement: 'partial',
      enforcement_reason: 'danger-full-access intentionally bypasses the filesystem sandbox',
    };
  }

  if (provider === 'agy' && input.mode === 'read-only') {
    return {
      mode: input.mode,
      networkAccess,
      ...(writableRoots ? { writableRoots } : {}),
      provider,
      enforcement: 'partial',
      enforcement_reason: 'agy exposes a sandbox flag but no verified read-only filesystem mode',
    };
  }

  return {
    mode: input.mode,
    networkAccess,
    ...(writableRoots ? { writableRoots } : {}),
    provider,
    enforcement: 'full',
    enforcement_reason: 'provider exposes the requested sandbox mode',
  };
}

/** Fail closed when a caller cannot operate with an approximate policy. */
export function requireSandboxEnforcement(
  policy: SandboxPolicy,
  required: SandboxEnforcement = 'full'
): SandboxPolicy {
  if (required === 'full' && policy.enforcement !== 'full') {
    throw new Error(
      `[SANDBOX_POLICY_PARTIAL] ${policy.provider ?? 'unknown'} cannot fully enforce ${policy.mode}: ${policy.enforcement_reason}`
    );
  }
  return policy;
}

/** Project the canonical policy into the Codex app-server request shape. */
export function toCodexSandboxPolicy(policy: SandboxPolicy): Record<string, unknown> {
  if (policy.mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (policy.mode === 'read-only') {
    return { type: 'readOnly', networkAccess: policy.networkAccess };
  }
  return {
    type: 'workspaceWrite',
    ...(policy.writableRoots ? { writableRoots: [...policy.writableRoots] } : {}),
    networkAccess: policy.networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
