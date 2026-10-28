import { randomUUID } from 'node:crypto';
import type { ScopedArtifactScope } from '../workforce/artifact-store.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';

export interface DelegationResultProjection {
  /** Structured consumers must receive the complete original payload. */
  format?: 'text' | 'structured';
  maxSummaryBytes?: number;
  parentContext?: {
    contextWindowTokens: number;
    /** Occupancy of the latest parent prompt, never cumulative session usage. */
    latestPromptTokens: number;
    reservedOutputTokens?: number;
    expectedResults?: number;
  };
  artifactScope?: ScopedArtifactScope;
  tier?: 'personal' | 'confidential' | 'public';
  /** Internal dispatch fence; not a source of ownership or authority. */
  canAcceptResult?: () => boolean;
}

export class DelegationResultProjectionError extends Error {
  constructor(
    message: string,
    readonly fullResult: string
  ) {
    super(message);
    this.name = 'DelegationResultProjectionError';
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

export function delegationSummaryBudget(options: DelegationResultProjection = {}): number {
  let bytes = positiveInteger(options.maxSummaryBytes ?? 24_000, 'summary byte ceiling');
  const parent = options.parentContext;
  if (parent) {
    const window = positiveInteger(parent.contextWindowTokens, 'context window');
    const used = parent.latestPromptTokens;
    const reserve = parent.reservedOutputTokens ?? 0;
    if (![used, reserve].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      throw new Error('Invalid latest parent prompt occupancy/output reserve');
    }
    const count = positiveInteger(parent.expectedResults ?? 1, 'expected result count');
    // A byte ceiling is deliberately conservative across scripts/tokenizers.
    // Half the remaining token headroom is reserved for other parent messages.
    bytes = Math.min(bytes, Math.max(0, Math.floor((window - used - reserve) / (2 * count))));
  }
  return bytes;
}

function isStructured(text: string): boolean {
  const trimmed = text.trim();
  // Preserve JSON and fenced machine payloads even when a caller omitted format.
  if (/```(?:task_result|json|xml|yaml|yml)\b/i.test(trimmed)) return true;
  // Preserve malformed/unsafe JSON-shaped data too: the consumer's schema
  // validator must diagnose it, rather than receiving an excerpt in its place.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
  try {
    parseSafeJsonInput(trimmed, 'Delegation structured result');
    return true;
  } catch {
    return false;
  }
}

export async function projectDelegationResult(
  result: string,
  options: DelegationResultProjection = {}
): Promise<string> {
  if (options.format === 'structured' || isStructured(result)) return result;
  const budget = delegationSummaryBudget(options);
  if (Buffer.byteLength(result, 'utf8') <= budget) return result;
  let artifactPath: string;
  try {
    if (!options.artifactScope || options.artifactScope.system) {
      throw new Error('a non-system owning artifact scope is required');
    }
    // Keep ownership resolution behind the call boundary: artifact-store's
    // governance dependencies also use agent dispatch during mission review.
    const { writeScopedArtifact } = await import('../workforce/artifact-store.js');
    if (options.canAcceptResult && !options.canAcceptResult()) {
      throw new Error('delegation attempt became terminal before artifact persistence');
    }
    artifactPath = writeScopedArtifact({
      scope: options.artifactScope,
      tier: options.tier,
      artifact_class: 'evidence',
      name: `delegation-results/${randomUUID()}.txt`,
      content: result,
      format: 'text',
      create_only: true,
    }).repo_relative_path;
  } catch (error) {
    throw new DelegationResultProjectionError(
      `Delegation result cannot be safely projected: ${error instanceof Error ? error.message : String(error)}`,
      result
    );
  }
  const footer = `\n[Result excerpt; full scoped result: ${artifactPath}]`;
  const available = budget - Buffer.byteLength(footer, 'utf8');
  if (available < 0) {
    throw new DelegationResultProjectionError(
      `Parent context has insufficient headroom for the scoped result reference: ${artifactPath}`,
      result
    );
  }
  const marker = '\n[… excerpt …]\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const chars = Array.from(result);
  const take = (values: string[], limit: number): string => {
    let size = 0;
    const kept: string[] = [];
    for (const char of values) {
      const length = Buffer.byteLength(char, 'utf8');
      if (size + length > limit) break;
      kept.push(char);
      size += length;
    }
    return kept.join('');
  };
  if (available < markerBytes) return take(chars, available) + footer;
  const headBytes = Math.ceil((available - markerBytes) / 2);
  const tailBytes = Math.floor((available - markerBytes) / 2);
  const head = take(chars, headBytes);
  const tail = Array.from(take(chars.reverse(), tailBytes)).reverse().join('');
  return head + marker + tail + footer;
}
