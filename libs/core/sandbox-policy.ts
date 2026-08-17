/**
 * DH-11: provider-neutral sandbox policy resolution.
 *
 * Permission presets describe intent; this module reports what the selected
 * provider can actually enforce. Callers that require a complete sandbox
 * must reject `partial` rather than treating a provider approximation as safe.
 */

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxEnforcement = 'full' | 'partial';

export interface SandboxPolicyInput {
  mode: SandboxMode;
  networkAccess?: boolean;
  writableRoots?: readonly string[];
  provider?: 'codex' | 'claude' | 'agy' | 'grok' | 'kyberion';
}

export interface SandboxPolicy {
  mode: SandboxMode;
  networkAccess: boolean;
  writableRoots?: readonly string[];
  provider: SandboxPolicyInput['provider'];
  enforcement: SandboxEnforcement;
  enforcement_reason: string;
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
