/**
 * Speculative-reply policy: whether the voice loop may start inference after
 * a short tentative silence (buffering the reply without speaking it) before
 * the end of turn is confirmed. Off by default; always off on battery power
 * or metered backends because every revoked end-of-turn burns a full request.
 */

import { getRegisteredEnvText } from './foundation/env.js';

export const SPECULATIVE_REPLY_ENV = 'KYBERION_VOICE_SPECULATIVE_REPLY';

export interface SpeculativeReplyPolicy {
  enabled: boolean;
  /** Tentative silence before speculative inference starts. */
  tentativeSilenceMs: number;
  /** Minimum partial transcript length worth speculating on. */
  minPartialChars: number;
  /** Why the policy is disabled, when it is. */
  disabled_reason?: 'default_off' | 'battery' | 'metered';
}

export interface ResolveSpeculativePolicyInput {
  /** Explicit caller option; wins over the environment when defined. */
  option?: boolean;
  env?: Record<string, string | undefined>;
  powerSource?: 'ac' | 'battery' | 'unknown';
  costTier?: 'free' | 'metered';
  tentativeSilenceMs?: number;
  minPartialChars?: number;
}

export const DEFAULT_TENTATIVE_SILENCE_MS = 250;
export const DEFAULT_MIN_PARTIAL_CHARS = 4;

function envEnabled(env: Record<string, string | undefined> | undefined): boolean {
  const raw = getRegisteredEnvText(SPECULATIVE_REPLY_ENV, env ? { env } : {});
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim());
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
  const requested = input.option ?? envEnabled(input.env);
  if (!requested) return { enabled: false, ...base, disabled_reason: 'default_off' };
  if (input.powerSource === 'battery')
    return { enabled: false, ...base, disabled_reason: 'battery' };
  if (input.costTier === 'metered') return { enabled: false, ...base, disabled_reason: 'metered' };
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
