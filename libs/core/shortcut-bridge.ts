import { randomUUID, createHash } from 'node:crypto';
import * as path from 'node:path';
import { resolveTenant } from './organization/tenant-registry.js';
import { isMacOS } from './platform.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { resolveIdentityContext } from './authority.js';
import { resolveStorageFloor } from './storage-layout.js';
import { safeMkdir, safeWriteFile, safeRmSync } from './secure-io.js';
import { spawnManagedProcess } from './managed-process.js';
import {
  createApprovalRequest,
  loadApprovalRequest,
  isApprovalRequestExpired,
} from './governance/approval-store.js';
import { assertApprovalUsable } from './governance/approval-separation-of-duties.js';
import { consumeApprovalWithin } from './governance/approval-revocation.js';
import { validateHumanFinalDecision } from './governance/approval-human-decision.js';
import { auditChain } from './governance/audit-chain.js';

const CHANNEL = 'apple-shortcuts';
type ShortcutFailureCode =
  | 'SHORTCUT_LAUNCH_FAILED'
  | 'SHORTCUT_TIMEOUT'
  | 'SHORTCUT_OUTPUT_LIMIT'
  | 'SHORTCUT_EXIT_FAILED'
  | 'SHORTCUT_INPUT_PREPARATION_FAILED'
  | 'SHORTCUT_EXECUTION_FAILED';
const FAILURE_REASONS: Record<ShortcutFailureCode, string> = {
  SHORTCUT_LAUNCH_FAILED: 'The Shortcuts process could not be started.',
  SHORTCUT_TIMEOUT: 'The shortcut exceeded its approved timeout; its effects may be incomplete.',
  SHORTCUT_OUTPUT_LIMIT:
    'The shortcut exceeded the bounded output limit; its effects may be incomplete.',
  SHORTCUT_EXIT_FAILED: 'The Shortcuts process exited with a failure status.',
  SHORTCUT_INPUT_PREPARATION_FAILED: 'The approved private input could not be prepared.',
  SHORTCUT_EXECUTION_FAILED: 'The shortcut did not complete successfully.',
};
interface ShortcutProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error_code?: ShortcutFailureCode;
}
export type ShortcutRunner = (args: string[], timeoutMs: number) => Promise<ShortcutProcessResult>;
let injectedRunner: ShortcutRunner | undefined;
export function setShortcutRunnerForTests(runner?: ShortcutRunner): void {
  injectedRunner = runner;
}
async function runProcess(args: string[], timeoutMs: number): Promise<ShortcutProcessResult> {
  if (injectedRunner) return injectedRunner(args, timeoutMs);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnManagedProcess>['child'];
    try {
      child = spawnManagedProcess({
        resourceId: 'apple-shortcuts:' + randomUUID(),
        kind: 'service',
        ownerId: 'shortcut-bridge',
        ownerType: 'core',
        command: '/usr/bin/shortcuts',
        args,
        shutdownPolicy: 'idle',
        idleTimeoutMs: timeoutMs + 5000,
      }).child;
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: String(err), error_code: 'SHORTCUT_LAUNCH_FAILED' });
      return;
    }
    let stdout = '',
      stderr = '',
      settled = false;
    const finish = (ok: boolean, error_code?: ShortcutFailureCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr, ...(error_code ? { error_code } : {}) });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false, 'SHORTCUT_TIMEOUT');
    }, timeoutMs);
    const collect = (kind: 'stdout' | 'stderr', chunk: unknown) => {
      const text = String(chunk);
      if (kind === 'stdout') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > 1_048_576) {
        child.kill();
        finish(false, 'SHORTCUT_OUTPUT_LIMIT');
      }
    };
    child.stdout?.on('data', (chunk) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk) => collect('stderr', chunk));
    child.once('error', () => finish(false, 'SHORTCUT_LAUNCH_FAILED'));
    child.once('close', (code) =>
      finish(code === 0, code === 0 ? undefined : 'SHORTCUT_EXIT_FAILED')
    );
    child.stdin?.end();
  });
}
function disabled(): boolean {
  return ['0', 'false', 'off'].includes(
    (getRegisteredEnvText('KYBERION_APPLE_FM') || '').toLowerCase()
  );
}
export async function listAppleShortcuts(): Promise<{
  available: boolean;
  names: string[];
  reason?: string;
}> {
  if (disabled()) return { available: false, names: [], reason: 'disabled via KYBERION_APPLE_FM' };
  if (!isMacOS()) return { available: false, names: [], reason: 'requires macOS' };
  if (!resolveIdentityContext().tenantSlug)
    return {
      available: false,
      names: [],
      reason: 'An active tenant is required for host shortcut inventory',
    };
  try {
    resolveTenant(resolveIdentityContext().tenantSlug!);
    const result = await runProcess(['list'], 15000);
    return result.ok
      ? {
          available: true,
          names: result.stdout
            .split(/\r?\n/u)
            .map((v) => v.trim())
            .filter(Boolean),
        }
      : { available: false, names: [], reason: 'Shortcuts listing unavailable' };
  } catch {
    return { available: false, names: [], reason: 'Shortcuts listing unavailable' };
  }
}
export interface RunAppleShortcutInput {
  name: string;
  input?: string;
  approval_request_id?: string;
  timeout_ms?: number;
}
export type RunAppleShortcutResult =
  | { status: 'approval_required'; approval_request_id: string; approval_channel: string }
  | { status: 'unavailable'; reason: string }
  | {
      status: 'completed' | 'failed';
      receipt: {
        approval_request_id: string;
        tenant_slug: string;
        payload_hash: string;
        success: boolean;
        shortcut_name: string;
        elapsed_ms: number;
      };
      output: string;
      error_code?: ShortcutFailureCode;
      reason?: string;
      next_action?: string;
    };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** A one-shot human decision binds shortcut name, exact text input digest, active tenant and timeout.
 * Consume before launch: a failed/ambiguous OS operation is never automatically retried.
 * The approved target is the named shortcut; changes made inside the Shortcuts app remain host-owned.
 */
export async function runAppleShortcut(
  input: RunAppleShortcutInput
): Promise<RunAppleShortcutResult> {
  if (disabled()) return { status: 'unavailable', reason: 'disabled via KYBERION_APPLE_FM' };
  if (!isMacOS()) return { status: 'unavailable', reason: 'requires macOS' };
  const identity = resolveIdentityContext();
  const tenant = identity.tenantSlug;
  if (!tenant) throw new Error('[SHORTCUT_SCOPE_REQUIRED] An active tenant is required');
  resolveTenant(tenant);
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.startsWith('-') ||
    /[\u0000-\u001f\u007f]/u.test(input.name)
  )
    throw new Error('[SHORTCUT_INPUT_INVALID] A literal shortcut name or identifier is required');
  if (
    input.input !== undefined &&
    (typeof input.input !== 'string' || Buffer.byteLength(input.input) > 1_048_576)
  )
    throw new Error('[SHORTCUT_INPUT_INVALID] Text input must be at most 1 MiB');
  const timeout = input.timeout_ms ?? 60000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000)
    throw new Error('[SHORTCUT_INPUT_INVALID] timeout_ms must be 1..300000');
  const payload = {
    operation: 'system:run_shortcut',
    tenant_slug: tenant,
    name: input.name,
    input_sha256: hash(input.input ?? ''),
    has_input: input.input !== undefined,
    timeout_ms: timeout,
  };
  const payloadHash = hash(JSON.stringify(payload));
  const effectBinding = 'apple-shortcut:' + tenant + ':' + payloadHash;
  if (!input.approval_request_id) {
    const request = createApprovalRequest('mission_controller', {
      channel: CHANNEL,
      storageChannel: CHANNEL,
      threadTs: effectBinding,
      correlationId: randomUUID(),
      requestedBy: 'shortcut-bridge',
      kind: 'channel-approval',
      scope: { tier: 'confidential', tenant_slug: tenant },
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      draft: {
        title: 'Run Apple Shortcut: ' + input.name,
        summary:
          'Run this named host shortcut once. Its effects may include external services and desktop actions.',
        details: JSON.stringify({ ...payload, input_text: input.input ?? null }, null, 2),
        severity: 'high',
      },
      requestedByContext: {
        surface: 'system',
        actorId: 'shortcut-bridge',
        actorRole: 'system-actuator',
        operationId: 'system:run_shortcut',
        executionBindingHash: payloadHash,
      },
      justification: {
        reason: 'Arbitrary Shortcuts can cause external effects; exact human approval is required.',
        requestedEffects: [effectBinding],
      },
      risk: { level: 'high', restartScope: 'none', requiresStrongAuth: true },
      accountability: { finalDecision: 'human_only', payloadHash, effectBinding },
    });
    return {
      status: 'approval_required',
      approval_request_id: request.id,
      approval_channel: CHANNEL,
    };
  }
  consumeApprovalWithin(
    'mission_controller',
    {
      channel: CHANNEL,
      requestId: input.approval_request_id,
      consumer: 'apple_shortcut_run',
      consumedBy: 'shortcut-bridge',
      effectRef: effectBinding,
    },
    (consume) => {
      const record = loadApprovalRequest(CHANNEL, input.approval_request_id!);
      if (
        !record ||
        record.scope?.tenant_slug !== tenant ||
        record.scope.tier !== 'confidential' ||
        isApprovalRequestExpired(record) ||
        !record.expiresAt ||
        record.accountability?.finalDecision !== 'human_only' ||
        record.accountability.payloadHash !== payloadHash ||
        record.accountability.effectBinding !== effectBinding
      )
        throw new Error(
          '[SHORTCUT_APPROVAL_MISMATCH] Exact unexpired tenant-bound approval required'
        );
      assertApprovalUsable(record, { consumer: 'apple_shortcut_run' });
      validateHumanFinalDecision({
        accountability: record.accountability,
        decidedByType: record.decidedByType,
        authenticated: record.authenticated,
        authMethod: record.decidedAuthMethod,
        payloadHash,
        effectBinding,
        mode: 'enforce',
        channel: CHANNEL,
      });
      consume();
    }
  );
  const startedAt = Date.now();
  let inputPath: string | undefined;
  let result: ShortcutProcessResult;
  let phase: 'input' | 'launch' = 'input';
  try {
    const args = ['run', input.name];
    if (input.input !== undefined) {
      inputPath = resolveStorageFloor(
        'scratch',
        { kind: 'tier', tier: 'confidential', tenant },
        'apple-shortcuts',
        randomUUID() + '.txt'
      );
      safeMkdir(path.dirname(inputPath), { recursive: true, mode: 0o700 });
      safeWriteFile(inputPath, input.input, { encoding: 'utf8', mode: 0o600 });
      args.push('--input-path', inputPath);
    }
    phase = 'launch';
    result = await runProcess(args, timeout);
  } catch (err) {
    result = {
      ok: false,
      stdout: '',
      stderr: String(err),
      error_code:
        phase === 'input' ? 'SHORTCUT_INPUT_PREPARATION_FAILED' : 'SHORTCUT_LAUNCH_FAILED',
    };
  } finally {
    if (inputPath) {
      try {
        safeRmSync(inputPath, { force: true });
      } catch {
        /* Preserve the consumed-attempt receipt; scratch retention handles cleanup. */
      }
    }
  }
  const receipt = {
    approval_request_id: input.approval_request_id,
    tenant_slug: tenant,
    payload_hash: payloadHash,
    success: result.ok,
    shortcut_name: input.name,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
  };
  const failureCode = result.ok ? undefined : (result.error_code ?? 'SHORTCUT_EXECUTION_FAILED');
  auditChain.record({
    agentId: 'shortcut-bridge',
    action: 'external_action',
    operation: 'system:run_shortcut',
    result: result.ok ? 'completed' : 'failed',
    correlationId: input.approval_request_id,
    scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant },
    // Audit only identifiers and bounded diagnostics, never the private name,
    // input, process output or stderr. The tenant-scoped caller retains its receipt.
    metadata: {
      approval_request_id: receipt.approval_request_id,
      tenant_slug: receipt.tenant_slug,
      payload_hash: receipt.payload_hash,
      success: receipt.success,
      elapsed_ms: receipt.elapsed_ms,
      ...(failureCode ? { error_code: failureCode } : {}),
    },
  });
  return {
    status: result.ok ? 'completed' : 'failed',
    receipt,
    output: result.stdout,
    ...(failureCode
      ? {
          error_code: failureCode,
          reason: FAILURE_REASONS[failureCode],
          next_action:
            'Inspect the named shortcut in the Shortcuts app and verify its effects. Request a new approval before retrying; this approval is already consumed.',
        }
      : {}),
  };
}
