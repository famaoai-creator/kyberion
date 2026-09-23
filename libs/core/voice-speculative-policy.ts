/**
 * Speculative-reply policy: whether the voice loop may start inference after
 * a short tentative silence (buffering the reply without speaking it) before
 * the end of turn is confirmed. Off by default; always off on battery power
 * or metered backends because every revoked end-of-turn burns a full request.
 */

import { getRegisteredEnvText } from './foundation/env.js';
import { safeExecResult } from './secure-io.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';

export const SPECULATIVE_REPLY_ENV = 'KYBERION_VOICE_SPECULATIVE_REPLY';

export type VoicePowerSource = 'ac' | 'battery' | 'unknown';
export type VoiceCostTier = 'free' | 'metered';

type PowerProbeExec = (
  command: string,
  args: string[]
) => { stdout: string; status: number | null };

export interface DetectPowerSourceOptions {
  platform?: NodeJS.Platform;
  exec?: PowerProbeExec;
}

/** Current power source; only macOS (`pmset -g batt`) is probed, others are unknown. */
export function detectVoicePowerSource(options: DetectPowerSourceOptions = {}): VoicePowerSource {
  if ((options.platform ?? process.platform) !== 'darwin') return 'unknown';
  const exec =
    options.exec ?? ((command, args) => safeExecResult(command, args, { timeoutMs: 2_000 }));
  try {
    const result = exec('pmset', ['-g', 'batt']);
    if (result.status !== 0) return 'unknown';
    if (/'Battery Power'/i.test(result.stdout)) return 'battery';
    if (/'AC Power'/i.test(result.stdout)) return 'ac';
  } catch {
    // Policy-blocked or missing binary: fall through.
  }
  return 'unknown';
}

// Local runtimes and subscription CLIs: a revoked speculation costs no per-request fee.
const FREE_REASONING_MODES: ReadonlySet<ReasoningBackendMode> = new Set<ReasoningBackendMode>([
  'claude-cli',
  'codex-cli',
  'gemini-cli',
  'agy-cli',
  'grok-cli',
  'copilot',
  'cursor-cli',
  'opencode-cli',
  'devin-cli',
  'local',
  'ollama',
  'vllm',
  'lmstudio',
  'llamacpp',
  'mlx',
  'localai',
  'stub',
]);

/** Cost tier of a reasoning backend mode; unknown or API-key backends are metered. */
export function costTierForReasoningMode(
  mode: ReasoningBackendMode | string | null | undefined
): VoiceCostTier {
  return mode && FREE_REASONING_MODES.has(mode as ReasoningBackendMode) ? 'free' : 'metered';
}

export interface SpeculativeReplyPolicy {
  enabled: boolean;
  /** Tentative silence before speculative inference starts. */
  tentativeSilenceMs: number;
  /** Minimum partial transcript length worth speculating on. */
  minPartialChars: number;
  /** Why the policy is disabled, when it is. */
  disabled_reason?: 'default_off' | 'battery' | 'metered' | 'power_unknown';
}

export interface ResolveSpeculativePolicyInput {
  /** Explicit caller option; wins over the environment when defined. */
  option?: boolean;
  env?: Record<string, string | undefined>;
  powerSource?: VoicePowerSource;
  costTier?: VoiceCostTier;
  tentativeSilenceMs?: number;
  minPartialChars?: number;
  /**
   * A caller that has its own reason to trust a non-AC/unknown power source
   * (or that has no battery, e.g. a desktop/server) may opt back in. Missing
   * powerSource/costTier otherwise fail closed: a caller that flips the
   * option on without wiring the probes must not silently get speculation.
   */
  allowUnknownPower?: boolean;
}

export const DEFAULT_TENTATIVE_SILENCE_MS = 250;
export const DEFAULT_MIN_PARTIAL_CHARS = 4;

function envEnabled(env: Record<string, string | undefined> | undefined): boolean {
  const raw = getRegisteredEnvText(SPECULATIVE_REPLY_ENV, env ? { env } : {});
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim());
}

/** Whether speculation was requested at all, before any power/cost guard runs. */
export function isSpeculativeReplyRequested(
  option: boolean | undefined,
  env?: Record<string, string | undefined>
): boolean {
  return option ?? envEnabled(env);
}

export function resolveSpeculativePolicy(
  input: ResolveSpeculativePolicyInput = {}
): SpeculativeReplyPolicy {
  const base = {
    tentativeSilenceMs: input.tentativeSilenceMs ?? DEFAULT_TENTATIVE_SILENCE_MS,
    minPartialChars: input.minPartialChars ?? DEFAULT_MIN_PARTIAL_CHARS,
  };
  if (!Number.isFinite(base.tentativeSilenceMs) || base.tentativeSilenceMs < 0) {
    throw new Error('speculative tentativeSilenceMs must be a finite non-negative number');
  }
  if (!Number.isFinite(base.minPartialChars) || base.minPartialChars < 0) {
    throw new Error('speculative minPartialChars must be a finite non-negative number');
  }
  const requested = isSpeculativeReplyRequested(input.option, input.env);
  if (!requested) return { enabled: false, ...base, disabled_reason: 'default_off' };
  // A caller enabling speculation without wiring the cost probe fails closed
  // as metered, not open as free.
  const costTier = input.costTier ?? 'metered';
  if (costTier === 'metered') return { enabled: false, ...base, disabled_reason: 'metered' };
  if (input.powerSource === 'battery')
    return { enabled: false, ...base, disabled_reason: 'battery' };
  // Missing/unknown power fails closed unless the caller explicitly accepts it.
  if (input.powerSource !== 'ac' && input.allowUnknownPower !== true) {
    return { enabled: false, ...base, disabled_reason: 'power_unknown' };
  }
  return { enabled: true, ...base };
}

/** Normalise width, case, punctuation and whitespace for speculation matching. */
export function normalizeSpeculativeTranscript(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, '')
    .replace(/\s+/g, '');
}

/**
 * The speculative reply may be flushed only when the final transcript says
 * the same thing the speculation was based on.
 */
export function transcriptsMatchForSpeculation(partial: string, final: string): boolean {
  const a = normalizeSpeculativeTranscript(partial);
  const b = normalizeSpeculativeTranscript(final);
  return a.length > 0 && a === b;
}
