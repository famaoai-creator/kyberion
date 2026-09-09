/* eslint-disable no-restricted-imports -- the provider boundary owns this managed CLI session process. */
/**
 * Cursor CLI session adapter — Kyberion-owned native subagent harness for
 * `cursor-agent -p --output-format json`.
 *
 * Unlike Grok/Claude ACP sessions, Cursor has no provider `spawn_subagent`
 * protocol. Each native delegation is an isolated `cursor-agent` spawn with
 * `--worktree <name>` so delegated work runs in a separate git worktree under
 * `~/.cursor/worktrees/…`. Kyberion owns that boundary; successful dispatch
 * always carries `nativeSubagent` metadata proving the worktree spawn.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AgentAskOptions, AgentResponse } from './agent-adapter.js';
import { childDelegationEnv } from './operation-policy-gate.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import {
  buildProviderChildEnv,
  resolveEffectiveProviderPermissionProfile,
  resolveProviderPermissionArgs,
  type ProviderPermissionProfileName,
} from './provider-permission-profiles.js';
import { assertReasoningEgressAllowed } from './reasoning-egress-scope.js';
import {
  delegationChildHandleFromChildProcess,
  withWallClockBudget,
  DelegationWallClockExceededError,
} from './delegation-concurrency.js';
import * as pathResolver from './path-resolver.js';

const DEFAULT_BIN = 'cursor-agent';
const DEFAULT_MODEL = 'auto';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEEP_MODEL = 'composer-2.5';
const FAST_MODEL = 'composer-2.5-fast';

function resolveModelForTier(
  tier: 'fast' | 'standard' | 'deep' | undefined,
  defaultModel: string
): string {
  if (tier === 'fast') {
    return defaultModel === 'auto' ? 'auto' : FAST_MODEL;
  }
  if (tier === 'deep') {
    return defaultModel === 'auto' ? DEEP_MODEL : defaultModel;
  }
  return defaultModel || DEFAULT_MODEL;
}

const GOVERNED_ARGUMENTS = new Set([
  '-p',
  '--output-format',
  '--model',
  '--trust',
  '--workspace',
  '--mode',
  '--sandbox',
  '--force',
  '--continue',
  '--resume',
  '--worktree',
  '--worktree-base',
]);

const CursorCliEnvelopeSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.unknown().optional(),
  duration_ms: z.number().optional(),
  session_id: z.string().optional(),
  request_id: z.string().optional(),
});

export interface CursorCliSessionAdapterOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  extraArgs?: readonly string[];
  workspaceDir?: string;
  spawnProcess?: typeof spawn;
}

export interface CursorNativeSubagentInfo {
  provider: 'cursor';
  mode: 'worktree-isolated-spawn';
  worktree: string;
  profile: ProviderPermissionProfileName;
  effort: 'low' | 'medium' | 'high' | 'ultra';
  proof: 'kyberion_owned_worktree_spawn';
  sessionId?: string;
}

function validateExtraArgs(args: readonly string[]): string[] {
  for (const arg of args) {
    const flag = arg.split('=', 1)[0];
    if (GOVERNED_ARGUMENTS.has(flag)) {
      throw new Error(`[cursor-cli] extra args may not override governed flag: ${flag}`);
    }
  }
  return [...args];
}

function normalizeProfile(value: unknown): ProviderPermissionProfileName {
  if (value === 'implementer' || value === 'explorer' || value === 'planner') return value;
  return 'implementer';
}

export class CursorCliSessionAdapter {
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly workspaceDir: string;
  private readonly spawnProcess: typeof spawn;
  private worktreeCounter = 0;
  private readonly sessionSuffix = randomBytes(4).toString('hex');
  private lastNativeSubagentInfo: CursorNativeSubagentInfo | null = null;

  constructor(options: CursorCliSessionAdapterOptions = {}) {
    this.bin = options.bin ?? DEFAULT_BIN;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraArgs = validateExtraArgs(options.extraArgs ?? []);
    this.workspaceDir = options.workspaceDir ?? pathResolver.rootDir();
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async boot(): Promise<void> {
    // Stateless harness: each native delegation is an isolated spawn.
  }

  async ask(_prompt: string, _options?: AgentAskOptions): Promise<AgentResponse> {
    throw new Error('[SUBAGENT_UNAVAILABLE] Cursor CLI adapter exposes native delegation only.');
  }

  async askNativeSubagent(prompt: string, options: AgentAskOptions = {}): Promise<AgentResponse> {
    assertReasoningEgressAllowed('cursor-cli');
    const profile = normalizeProfile(options.profile);
    const effectiveProfile = resolveEffectiveProviderPermissionProfile('cursor', profile);
    const permission = resolveProviderPermissionArgs(effectiveProfile ?? profile, 'cursor');
    if (permission.kind === 'refused') {
      throw new Error(`[SUBAGENT_UNAVAILABLE] ${permission.reason}`);
    }

    const worktree = `kyberion-${profile}-${this.sessionSuffix}-${++this.worktreeCounter}`;
    const model = resolveModelForTier(
      options.tier as 'fast' | 'standard' | 'deep' | undefined,
      this.model
    );
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      model,
      '--trust',
      '--workspace',
      this.workspaceDir,
      '--worktree',
      worktree,
      ...permission.args,
      ...this.extraArgs,
      prompt,
    ];

    const stdout = await this.spawnCli(args, options.signal);
    const { text, sessionId } = this.parseEnvelope(stdout);
    const effort = options.effort ?? 'medium';
    const nativeSubagent: CursorNativeSubagentInfo = {
      provider: 'cursor',
      mode: 'worktree-isolated-spawn',
      worktree,
      profile: effectiveProfile ?? profile,
      effort,
      proof: 'kyberion_owned_worktree_spawn',
      ...(sessionId ? { sessionId } : {}),
    };
    this.lastNativeSubagentInfo = nativeSubagent;

    return {
      text,
      stopReason: 'completed',
      metadata: { nativeSubagent },
    };
  }

  getRuntimeInfo(): Record<string, unknown> {
    return {
      supportsNativeSubagents: true,
      lastNativeSubagent: this.lastNativeSubagentInfo,
    };
  }

  async shutdown(): Promise<void> {
    this.worktreeCounter = 0;
    this.lastNativeSubagentInfo = null;
  }

  private parseEnvelope(stdout: string): { text: string; sessionId?: string } {
    let cliResult: unknown;
    try {
      cliResult = parseSafeJsonInput(stdout, 'Cursor CLI response');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[cursor-cli] failed to parse CLI JSON output: ${message}. Raw: ${stdout.slice(0, 500)}`
      );
    }

    const envelope = CursorCliEnvelopeSchema.safeParse(cliResult);
    if (!envelope.success) {
      throw new Error(
        `[cursor-cli] unexpected CLI envelope: ${JSON.stringify(cliResult).slice(0, 500)}`
      );
    }
    if (envelope.data.is_error) {
      throw new Error(
        `[cursor-cli] CLI reported error: ${typeof envelope.data.result === 'string' ? envelope.data.result : JSON.stringify(envelope.data.result).slice(0, 500)}`
      );
    }

    const sessionId =
      typeof envelope.data.session_id === 'string' && envelope.data.session_id.trim()
        ? envelope.data.session_id.trim()
        : undefined;

    if (typeof envelope.data.result === 'string') {
      return { text: envelope.data.result, ...(sessionId ? { sessionId } : {}) };
    }
    if (envelope.data.result !== undefined && envelope.data.result !== null) {
      return {
        text: JSON.stringify(envelope.data.result),
        ...(sessionId ? { sessionId } : {}),
      };
    }
    throw new Error(
      `[cursor-cli] CLI did not emit result. Envelope: ${JSON.stringify(envelope.data).slice(0, 500)}`
    );
  }

  private spawnCli(args: string[], signal?: AbortSignal): Promise<string> {
    const child = this.spawnProcess(this.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...buildProviderChildEnv({ provider: 'cursor' }), ...childDelegationEnv() },
    }) as ChildProcessWithoutNullStreams;

    return withWallClockBudget(
      {
        provider: 'cursor',
        budgetMs: this.timeoutMs,
        child: delegationChildHandleFromChildProcess(child),
        signal,
      },
      () =>
        new Promise<string>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
          child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
          child.on('close', (code) => {
            if (code !== 0) {
              reject(
                new Error(
                  `[cursor-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
                )
              );
              return;
            }
            resolve(stdout);
          });
          child.on('error', (err) => {
            reject(new Error(`[cursor-cli] spawn failed: ${err.message}`));
          });
          child.stdin.end();
        })
    ).catch((err) => {
      if (err instanceof DelegationWallClockExceededError) {
        throw new Error(`[cursor-cli] timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    });
  }
}
