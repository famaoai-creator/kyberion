/**
 * Best-of-Providers Delegation — XP-07 (model-diverse best-of-N)
 *
 * `mission-orchestration-worker.ts`'s MO-07 best-of-2 (`obtainBestOfTaskResultResponse`)
 * runs the SAME model twice with different approach directives and judges
 * between them — it cancels out prompt-framing bias but not *model* bias.
 * CT-03's lens-fan-out is the same-model / different-viewpoint axis. This
 * module is the complementary, orthogonal axis: fan the same instruction out
 * to *different provider CLIs* (claude / codex / agy / …) concurrently and
 * judge across them, so systematic biases of any one model/vendor get
 * diluted rather than reinforced. Suited to review/judgment/risk-assessment
 * tasks by default (per the plan), but this module itself is domain-neutral.
 *
 * Composition with the rest of the XP wave:
 * - XP-01 (`provider-capability-registry.ts`) supplies the default candidate
 *   list — providers with `binary_found: true` in the cached probe snapshot.
 * - XP-03 (`provider-egress-gate.ts`) is the participation gate: every
 *   candidate is checked with `checkProviderEgress({provider, dataTier})`
 *   before fan-out; a denial excludes the provider (surfaced in
 *   `result.excluded`), it never aborts the whole run.
 * - XP-06 (`delegation-concurrency.ts`) wraps every individual provider call
 *   in `withDelegationSlot({provider}, ...)`, so a best-of-N fan-out cannot
 *   itself blow through the global/per-provider concurrency caps.
 * - MO-07 (`structured-output-contracts.ts`'s `PlanningReviewVerdictSchema` —
 *   `{approve, gaps, rationale}`) is the judge-record shape this module's
 *   verdict conforms to (nested under `verdictRecord.verdict`), so the same
 *   consumers that already understand MO-07 verdicts can read a best-of-
 *   providers verdict without a second shape to learn.
 *
 * Backend acquisition: there is no clean, exported "give me a backend for
 * provider X" factory in `reasoning-bootstrap.ts` — it builds exactly one
 * *installed* backend per process (`providerForReasoningMode` is private,
 * the install path is a singleton via
 * `registerReasoningBackend`/`getReasoningBackend`), and that file is out of
 * scope for this module to reach into. Instead this module defines its own
 * minimal structural interface (`BestOfProviderBackend` — just
 * `delegateTask(instruction, context?)`, the same call shape as
 * `ReasoningBackend.delegateTask`, so real `ReasoningBackend` instances
 * satisfy it with no adapter) and accepts backend acquisition as an
 * injectable seam (`seams.getBackend`).
 *
 * Default `seams.getBackend` (XP-07 close-out — see `provider-backend-resolver.ts`
 * for the resolver itself and its per-provider constructor rationale):
 * gated behind the `KYBERION_BEST_OF_PROVIDERS_LIVE=1` opt-in env var.
 *   - Unset (the production default): every candidate call resolves to "no
 *     backend available" and is recorded as a per-candidate soft failure
 *     (never a thrown error; see `runBestOfProviders`'s per-candidate
 *     try/catch) — so nothing starts spawning provider CLIs just because
 *     `runBestOfProviders` is called. Nothing in this repo sets this env
 *     var today, so best-of-providers stays inert-by-default in production
 *     until an operator/deployment explicitly opts in.
 *   - `KYBERION_BEST_OF_PROVIDERS_LIVE=1`: delegates to
 *     `resolveProviderBackend` (`provider-backend-resolver.ts`), which
 *     lazily constructs a real 'claude'/'codex'/'agy' CLI-backed backend
 *     (never spawns at resolve time — only when `delegateTask` is actually
 *     called), gated by the XP-01 cached capability registry.
 * A caller can still inject its own `seams.getBackend` (e.g. a future real
 * multi-provider dispatcher) to override this default entirely, live-flag
 * or not. In the common case where only one provider is actually available,
 * this degrades to the documented `degraded: 'single-provider'` /
 * `degraded: 'no-eligible-providers'` outcomes rather than failing.
 *
 * Judge: the default judge (`defaultBestOfProvidersJudge`) is a deterministic
 * heuristic — normalized token-Jaccard similarity between candidate outputs,
 * majority/plurality agreement decides the winner, ties break by input
 * order. It never calls an LLM. Callers that want semantic (not lexical)
 * comparison inject their own `judge` (e.g. one that delegates a judge
 * prompt to a reasoning backend, mirroring MO-07's
 * `obtainBestOfTaskResultResponse` judge call) — the seam is intentionally
 * the same shape either way.
 *
 * Persistence: verdict records are metadata-only (provider ids, votes,
 * verdict, an instruction digest) — deliberately NOT the raw instruction or
 * candidate output text. `active/shared/runtime/` is an operational area,
 * not itself tier-scoped the way `knowledge/{personal,confidential,public}/`
 * is; writing raw confidential/personal content into it would be a tier leak
 * (CLAUDE.md invariant 1), so this module records `data_tier` and a SHA-256
 * digest of the instruction+context for traceability instead of the content
 * itself. A caller-injected judge's `rationale` string is persisted as-is —
 * an LLM judge that echoes source content into its rationale is a risk the
 * injecting caller owns, not something this module can police generically.
 *
 * See docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-07.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile } from './secure-io.js';
import { checkProviderEgress } from './provider-egress-gate.js';
import {
  peekProviderCapabilityRegistry,
  type ProviderCapability,
} from './provider-capability-registry.js';
import { withDelegationSlot } from './delegation-concurrency.js';
import { resolveProviderBackend } from './provider-backend-resolver.js';
import type { TierLevel } from './types.js';
import type { PlanningReviewVerdictResult } from './structured-output-contracts.js';

/**
 * Env flag that opts the default `seams.getBackend` into real per-provider
 * CLI delegation (via `resolveProviderBackend`). See module header. Unset
 * ⇒ default resolver stays the always-null no-op (production-safe).
 */
export const BEST_OF_PROVIDERS_LIVE_ENV_VAR = 'KYBERION_BEST_OF_PROVIDERS_LIVE';

/**
 * Minimal structural shape this module needs from a provider backend — the
 * same call signature as `ReasoningBackend.delegateTask` (`reasoning-backend.ts`)
 * but declared independently so this module never imports that file (see
 * header: it is owned by a concurrent track this wave). A real
 * `ReasoningBackend` satisfies this interface with no adapter.
 */
export interface BestOfProviderBackend {
  delegateTask(instruction: string, context?: string): Promise<string>;
}

/** Injectable backend-acquisition seam. Default: `null` for every provider (see header). */
export type BestOfProvidersBackendResolver = (
  provider: string
) => BestOfProviderBackend | null | undefined;

export interface BestOfProvidersCandidateResult {
  provider: string;
  output: string | null;
  error?: string;
}

export interface BestOfProvidersJudgeInput {
  instruction: string;
  context?: string;
  candidates: BestOfProvidersCandidateResult[];
}

export interface BestOfProvidersJudgeVerdict {
  winnerProvider: string | null;
  approve: boolean;
  gaps: string[];
  rationale?: string;
  /** provider -> vote/agreement count. Always includes every judged (non-null-output) provider. */
  votes: Record<string, number>;
}

/** Injectable judge seam. Default is `defaultBestOfProvidersJudge` (deterministic, no LLM call). */
export type BestOfProvidersJudge = (
  input: BestOfProvidersJudgeInput
) => BestOfProvidersJudgeVerdict | Promise<BestOfProvidersJudgeVerdict>;

export interface BestOfProvidersExclusion {
  provider: string;
  reason: string;
}

export type BestOfProvidersDegradation = 'single-provider' | 'no-eligible-providers';

export interface BestOfProvidersVerdictRecord {
  ts: string;
  data_tier: TierLevel;
  /** SHA-256 (first 16 hex chars) of `instruction + '\0' + context` — traceable without persisting content. */
  instruction_digest: string;
  /** MO-07-compatible verdict shape (`PlanningReviewVerdictSchema`: approve/gaps/rationale). */
  verdict: PlanningReviewVerdictResult;
  winner: string | null;
  /** Providers that actually produced a non-null output and were judged. */
  participants: string[];
  votes: Record<string, number>;
  excluded: BestOfProvidersExclusion[];
  degraded?: BestOfProvidersDegradation;
}

export interface BestOfProvidersSeams {
  /** Default: returns `null` for every provider — see module header. */
  getBackend?: BestOfProvidersBackendResolver;
  /** Default: `peekProviderCapabilityRegistry` (XP-01 cached snapshot; never live-probes). */
  registrySnapshot?: () => ProviderCapability[] | null;
  now?: () => Date;
  /** Default: `pathResolver.shared(VERDICT_LOG_RELATIVE_PATH)`. Override for tests (mirrors `context-promotion-ledger.ts`'s `ledger_path`). */
  verdictLogPath?: string;
}

export interface RunBestOfProvidersOptions {
  instruction: string;
  context?: string;
  dataTier: TierLevel;
  /** Explicit provider id list. When omitted (or empty), falls back to the XP-01 registry snapshot. */
  providers?: string[];
  /** Default: `defaultBestOfProvidersJudge` (deterministic heuristic, no LLM call). */
  judge?: BestOfProvidersJudge;
  seams?: BestOfProvidersSeams;
}

export interface BestOfProvidersResult {
  winner: { provider: string; output: string } | null;
  candidates: BestOfProvidersCandidateResult[];
  verdictRecord: BestOfProvidersVerdictRecord;
  excluded: BestOfProvidersExclusion[];
}

/** Relative path (under `active/shared/`) of the persisted verdict-record JSONL log. */
export const BEST_OF_PROVIDERS_VERDICT_LOG_RELATIVE_PATH =
  'runtime/best-of-providers/verdicts.jsonl';

/**
 * Default `seams.getBackend`. No-op (`null` for every provider) unless
 * `KYBERION_BEST_OF_PROVIDERS_LIVE=1` is set, in which case it delegates to
 * `resolveProviderBackend` (see module header + `provider-backend-resolver.ts`).
 * Never throws — `resolveProviderBackend` itself never throws, but this
 * still guards defensively since it runs inside `runBestOfProviders`'s
 * per-candidate path.
 */
function defaultBackendResolver(provider: string): BestOfProviderBackend | null {
  if (process.env[BEST_OF_PROVIDERS_LIVE_ENV_VAR] !== '1') return null;
  try {
    return resolveProviderBackend(provider);
  } catch {
    return null;
  }
}

function defaultRegistrySnapshot(): ProviderCapability[] | null {
  return peekProviderCapabilityRegistry();
}

function defaultCandidateProviders(seams: BestOfProvidersSeams | undefined): string[] {
  const snapshotFn = seams?.registrySnapshot ?? defaultRegistrySnapshot;
  let snapshot: ProviderCapability[] | null;
  try {
    snapshot = snapshotFn();
  } catch {
    snapshot = null;
  }
  if (!snapshot) return [];
  return snapshot.filter((entry) => entry.binary_found).map((entry) => entry.provider_id);
}

function digestOf(instruction: string, context?: string): string {
  return createHash('sha256')
    .update(`${instruction || ''} ${context || ''}`)
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Default judge — deterministic normalized token-Jaccard agreement. No LLM
// call; see module header for how to inject one instead.
// ---------------------------------------------------------------------------

const AGREEMENT_SIMILARITY_THRESHOLD = 0.3;

function tokenize(text: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9぀-ヿ゠-ヿ一-鿿]+/gi, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Deterministic default judge: prefer the candidate output most other
 * candidates agree with (normalized token-Jaccard similarity), ties broken
 * by input order. Never calls an LLM — inject `options.judge` for a semantic
 * (model-backed) comparison instead.
 */
export const defaultBestOfProvidersJudge: BestOfProvidersJudge = ({
  candidates,
}: BestOfProvidersJudgeInput): BestOfProvidersJudgeVerdict => {
  const scored = candidates.filter(
    (candidate) => candidate.output !== null && candidate.output !== undefined
  );
  const gaps = candidates
    .filter((candidate) => candidate.output === null || candidate.output === undefined)
    .map((candidate) => `${candidate.provider}: ${candidate.error || 'no output produced'}`);

  if (scored.length === 0) {
    return {
      winnerProvider: null,
      approve: false,
      gaps: gaps.length > 0 ? gaps : ['no candidate produced output'],
      rationale: 'heuristic judge: no eligible candidate produced output',
      votes: {},
    };
  }

  if (scored.length === 1) {
    const only = scored[0];
    return {
      winnerProvider: only.provider,
      approve: true,
      gaps,
      rationale: `heuristic judge: single eligible provider ('${only.provider}') — no comparison performed`,
      votes: { [only.provider]: 1 },
    };
  }

  const tokenSets = scored.map((candidate) => tokenize(candidate.output as string));
  const agreementScores = scored.map((_candidate, i) => {
    let total = 0;
    for (let j = 0; j < scored.length; j++) {
      if (j === i) continue;
      total += jaccardSimilarity(tokenSets[i], tokenSets[j]);
    }
    return total;
  });

  const votes: Record<string, number> = {};
  scored.forEach((candidate, i) => {
    let agreementCount = 0;
    for (let j = 0; j < scored.length; j++) {
      if (j === i) continue;
      if (jaccardSimilarity(tokenSets[i], tokenSets[j]) >= AGREEMENT_SIMILARITY_THRESHOLD) {
        agreementCount += 1;
      }
    }
    votes[candidate.provider] = agreementCount;
  });

  let winnerIndex = 0;
  for (let i = 1; i < scored.length; i++) {
    if (agreementScores[i] > agreementScores[winnerIndex]) winnerIndex = i;
  }
  const winner = scored[winnerIndex];

  return {
    winnerProvider: winner.provider,
    approve: true,
    gaps,
    rationale:
      `heuristic judge: selected '${winner.provider}' by highest normalized token-Jaccard ` +
      `agreement across ${scored.length} candidates (score=${agreementScores[winnerIndex].toFixed(3)}); ` +
      'ties broken by input order. Not an LLM judge — inject one via options.judge for semantic comparison.',
    votes,
  };
};

// ---------------------------------------------------------------------------
// Verdict-record persistence
// ---------------------------------------------------------------------------

function persistVerdictRecord(record: BestOfProvidersVerdictRecord, filePath: string): void {
  try {
    const dir = path.dirname(filePath);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    safeAppendFileSync(filePath, `${JSON.stringify(record)}\n`);
  } catch (err) {
    logger.warn(
      `[best-of-providers] failed to persist verdict record (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Test/ops-only: read back the persisted verdict-record JSONL log as-is. */
export function peekBestOfProvidersVerdictLog(
  filePath: string = pathResolver.shared(BEST_OF_PROVIDERS_VERDICT_LOG_RELATIVE_PATH)
): BestOfProvidersVerdictRecord[] {
  try {
    if (!safeExistsSync(filePath)) return [];
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BestOfProvidersVerdictRecord);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fan the same instruction/context out to multiple provider backends
 * concurrently, gated by XP-03 egress and XP-06 concurrency, and aggregate
 * the results via a judge (default: deterministic heuristic; see module
 * header). Never throws for provider-level failure: an individual provider
 * exclusion (egress) or failure (no backend / call error) degrades that one
 * candidate to `null`/`error`, never the whole run. A single eligible
 * provider runs alone (`verdictRecord.degraded === 'single-provider'`); zero
 * eligible providers still returns a (non-throwing) result with
 * `verdictRecord.degraded === 'no-eligible-providers'`.
 */
export async function runBestOfProviders(
  options: RunBestOfProvidersOptions
): Promise<BestOfProvidersResult> {
  const instruction = options.instruction;
  const context = options.context;
  const dataTier = options.dataTier;
  const now = options.seams?.now ?? (() => new Date());
  const getBackend = options.seams?.getBackend ?? defaultBackendResolver;
  const judge = options.judge ?? defaultBestOfProvidersJudge;
  const verdictLogPath =
    options.seams?.verdictLogPath ??
    pathResolver.shared(BEST_OF_PROVIDERS_VERDICT_LOG_RELATIVE_PATH);

  const explicitProviders = (options.providers || [])
    .map((provider) => String(provider || '').trim())
    .filter(Boolean);
  const baseProviders =
    explicitProviders.length > 0
      ? Array.from(new Set(explicitProviders))
      : defaultCandidateProviders(options.seams);

  const excluded: BestOfProvidersExclusion[] = [];
  const eligible: string[] = [];
  for (const provider of baseProviders) {
    const check = checkProviderEgress({ provider, dataTier });
    if (check.allowed) {
      eligible.push(provider);
    } else {
      excluded.push({ provider, reason: check.reason || 'provider egress denied' });
    }
  }

  const candidates: BestOfProvidersCandidateResult[] = await Promise.all(
    eligible.map((provider) =>
      withDelegationSlot({ provider }, async (): Promise<BestOfProvidersCandidateResult> => {
        try {
          const backend = getBackend(provider);
          if (!backend) {
            return {
              provider,
              output: null,
              error: 'no backend available for provider (no seams.getBackend resolver injected)',
            };
          }
          const output = await backend.delegateTask(instruction, context);
          return { provider, output };
        } catch (err) {
          return {
            provider,
            output: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    )
  );

  const judgeVerdict = await judge({ instruction, context, candidates });
  const participants = candidates
    .filter((candidate) => candidate.output !== null && candidate.output !== undefined)
    .map((candidate) => candidate.provider);

  let degraded: BestOfProvidersDegradation | undefined;
  if (eligible.length === 0) degraded = 'no-eligible-providers';
  else if (eligible.length === 1) degraded = 'single-provider';

  const verdictRecord: BestOfProvidersVerdictRecord = {
    ts: now().toISOString(),
    data_tier: dataTier,
    instruction_digest: digestOf(instruction, context),
    verdict: {
      approve: judgeVerdict.approve,
      gaps: judgeVerdict.gaps,
      rationale: judgeVerdict.rationale,
    },
    winner: judgeVerdict.winnerProvider,
    participants,
    votes: judgeVerdict.votes,
    excluded,
    ...(degraded ? { degraded } : {}),
  };

  persistVerdictRecord(verdictRecord, verdictLogPath);

  const winnerCandidate = judgeVerdict.winnerProvider
    ? candidates.find(
        (candidate) =>
          candidate.provider === judgeVerdict.winnerProvider &&
          candidate.output !== null &&
          candidate.output !== undefined
      )
    : undefined;

  return {
    winner: winnerCandidate
      ? { provider: winnerCandidate.provider, output: winnerCandidate.output as string }
      : null,
    candidates,
    verdictRecord,
    excluded,
  };
}
