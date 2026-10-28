import { getRegisteredEnvText } from '../foundation/env.js';

/** Shared capacity policy, independent of compaction and agent dispatch mechanisms. */
export interface ContextWindowProfile {
  contextWindowTokens: number;
  reserveTokens: number;
  bufferTokens: number;
}

function readEnvTokens(name: string): number | undefined {
  const raw = getRegisteredEnvText(name);
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function resolveContextWindowProfile(
  overrides?: Partial<ContextWindowProfile>
): ContextWindowProfile {
  return {
    contextWindowTokens:
      overrides?.contextWindowTokens ?? readEnvTokens('KYBERION_CONTEXT_WINDOW_TOKENS') ?? 200_000,
    reserveTokens:
      overrides?.reserveTokens ?? readEnvTokens('KYBERION_CONTEXT_RESERVE_TOKENS') ?? 32_000,
    bufferTokens:
      overrides?.bufferTokens ?? readEnvTokens('KYBERION_CONTEXT_BUFFER_TOKENS') ?? 8_000,
  };
}
