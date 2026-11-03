/**
 * Provider chain router — the shared selection skeleton for named seams whose
 * providers offer the same function with different traits (OCR, image/music
 * generation, …).
 *
 * What is shared here (each domain used to re-implement it):
 *   1. eligibility: the domain's `candidates()` hard-filters providers for the
 *      request; membership in the result is the only admission test;
 *   2. governed selection: a purpose, mission pin or matching operator rule
 *      resolves through `resolveSeamProviderDecision` (audited, pinnable);
 *   3. ordering: `lead` (rule/pin winner) → explicit `providerPreference` →
 *      the seam policy's `default_chains` entry for the request's
 *      `defaultOrderKey` (falling back to the 'default' chain) → every other
 *      registered provider;
 *   4. execution order and last-error iteration stay with the domain — the
 *      egress wrapping, consent receipts and retry semantics differ too much
 *      to share.
 *
 * Domain quirks that intentionally differ are hooks on `ProviderChainSpec`,
 * not copied code.
 */

import { logger } from './core.js';
import {
  explainSeamProviderDecision,
  getSeamSelectionPolicy,
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  resolveSeamSelectionEntry,
  type ResolveSeamProviderOptions,
  type SeamProviderCandidate,
} from './seam-provider-selection.js';

export interface ProviderChainSpec<TProvider, TRequest> {
  /** Named seam the chain selects from, e.g. 'ocr-provider'. */
  seam: string;
  /** Log prefix for selection lines, e.g. '[ocr_bridge]'. */
  label: string;
  /** Error tag for governed-selection failures, e.g. '[OCR_PROVIDER_SELECTION]'. */
  errorTag: string;
  /**
   * Hard eligibility of every provider for this request (domain rules +
   * availability). `flags` is the opaque value passed to
   * `resolveProviderIds(request, flags)` for per-call variants (e.g. consent
   * checks suppressed while planning).
   */
  eligibility(request: TRequest, flags?: unknown): Promise<SeamProviderCandidate[]>;
  providerId?: (provider: TProvider) => string;
  /** Request-pinned provider ids; when non-empty they keep their order. */
  explicitPreference?: (request: TRequest) => readonly string[] | undefined;
  /**
   * True: an explicit preference IS the chain — no default order, no tail,
   * no eligibility filter; the domain's execution loop reports failures
   * itself (music). False/absent: the preference leads the default chain and
   * everything is re-checked against eligibility (OCR, image).
   */
  preferenceOnly?: boolean;
  purpose?: (request: TRequest) => string | undefined;
  /** Request facts operator rules may match on, e.g. { language: 'ja' }. */
  context?: (request: TRequest) => Record<string, string> | undefined;
  decisionKey?: (request: TRequest) => string | undefined;
  /**
   * Discriminator selecting the ordering from the seam policy's
   * `default_chains` (e.g. `mode:accurate`, `platform:apple_silicon`). With no
   * matching key the policy's 'default' chain applies; with no chains at all
   * the eligible tail keeps registration order.
   */
  defaultOrderKey?: (request: TRequest) => string;
  /**
   * Ordering used only when the seam policy cannot supply one (isolated test
   * environments without the knowledge directory, or a policy that declares
   * no default_chains). Production ordering comes from the policy — this is
   * the hermetic fallback, not the source of truth.
   */
  builtinDefaultOrder?: (request: TRequest) => readonly string[];
  /**
   * 'chain': a governed decision replaces the ordering with its ranked list
   * (rules/pins included) — the OCR behaviour.
   * 'lead': only the winner of a rule/pin decision leads the default order —
   * the image/music behaviour. A purpose always yields the full ranked chain.
   */
  governedScope?: 'chain' | 'lead';
  /** Unknown purposes fail listing the declared ones (image/music). */
  strictPurposes?: boolean;
  /** Sort the eligible tail alphabetically instead of registration order (music). */
  sortEligibleTail?: boolean;
  /**
   * False: unlisted registered providers are NOT appended after the default
   * chain (image: a provider must appear in a default_chains entry or be
   * reached through the fallback graph to serve). Default true: every
   * registered provider trails in registration order, so a newly registered
   * provider is reachable without editing the policy.
   */
  registrationTail?: boolean;
  /**
   * Extra provider ids appended after the resolved chain (still filtered by
   * eligibility) — e.g. image fallback_backend_id graph expansion.
   */
  chainTail?: (ids: readonly string[], request: TRequest) => readonly string[];
}

/**
 * A governed selection resolved to nothing. Domains that report selection
 * failure as a result value (not a throw) catch this and read `.message` —
 * strict-purpose validation errors stay plain Errors and still propagate.
 */
export class ProviderSelectionError extends Error {
  readonly rationale: string;
  constructor(tag: string, rationale: string) {
    super(`${tag} ${rationale}`);
    this.name = 'ProviderSelectionError';
    this.rationale = rationale;
  }
}

/** `id: reason` pairs joined for "nothing could run" diagnostics. */
export function unmetCandidateSummary(candidates: readonly SeamProviderCandidate[]): string {
  return candidates
    .map((candidate) => `${candidate.id}: ${(candidate.unmet ?? []).join(', ') || 'ineligible'}`)
    .join('; ');
}

export class ProviderChainRouter<TProvider extends { id?: string }, TRequest> {
  protected readonly providers = new Map<string, TProvider>();

  constructor(
    providers: readonly TProvider[],
    protected readonly spec: ProviderChainSpec<TProvider, TRequest>
  ) {
    for (const provider of providers) {
      const id = spec.providerId?.(provider) ?? provider.id;
      if (id) this.providers.set(id, provider);
    }
  }

  /**
   * Ordering for this request: the seam policy's `default_chains` entry for
   * `defaultOrderKey` (or its 'default' chain), else the domain's builtin
   * fallback when the policy is unavailable or declares nothing.
   */
  private defaultOrder(request: TRequest): readonly string[] {
    const key = this.spec.defaultOrderKey?.(request);
    try {
      const chains = getSeamSelectionPolicy(this.spec.seam)?.default_chains;
      if (chains) {
        if (key && chains[key]?.length) return chains[key];
        if (chains['default']?.length) return chains['default'];
      }
    } catch {
      // The policy directory may be absent in isolated test environments;
      // fall through to the domain's builtin ordering.
    }
    return this.spec.builtinDefaultOrder?.(request) ?? [];
  }

  /** Full governed replacement chain; throws `${errorTag} rationale` when unresolved. */
  private async governedIds(
    request: TRequest,
    entryRequest: Omit<ResolveSeamProviderOptions, 'candidates'>
  ): Promise<string[]> {
    const purpose = entryRequest.purpose;
    if (this.spec.strictPurposes && purpose) {
      const known = listSeamSelectionPurposes(this.spec.seam);
      if (!known.includes(purpose)) {
        throw new Error(
          `${this.spec.errorTag} unknown purpose '${purpose}' for seam '${this.spec.seam}' (known: ${known.join(', ')})`
        );
      }
    }
    const candidates = await this.spec.eligibility(request);
    const decision = resolveSeamProviderDecision({ ...entryRequest, candidates });
    if (!decision.provider_id) {
      throw new ProviderSelectionError(this.spec.errorTag, decision.rationale);
    }
    logger.info(
      `${this.spec.label} provider '${decision.provider_id}' selected (${decision.strategy}): ${decision.rationale}`
    );
    return decision.ranked.filter((id) => this.providers.has(id));
  }

  /**
   * Rule/pin winner that leads the default order (governedScope 'lead'). Only
   * 'rule' and 'pinned' strategies qualify — a purpose/default/fallback
   * decision leaves the default chain untouched, and a rule whose providers
   * are all ineligible yields no lead.
   */
  private async ruleLead(
    request: TRequest,
    entryRequest: Omit<ResolveSeamProviderOptions, 'candidates'>
  ): Promise<string[]> {
    const options: ResolveSeamProviderOptions = {
      ...entryRequest,
      candidates: await this.spec.eligibility(request),
    };
    const preview = explainSeamProviderDecision(options);
    if (preview.strategy !== 'rule' && preview.strategy !== 'pinned') return [];
    const decision = resolveSeamProviderDecision(options);
    if (!decision.provider_id) return [];
    logger.info(
      `${this.spec.label} provider '${decision.provider_id}' leads the chain (${decision.strategy}): ${decision.rationale}`
    );
    return [decision.provider_id];
  }

  /**
   * Provider ids to try, best first. Explicit preferences keep their order and
   * skip selection entirely; governed entries rank or lead per governedScope;
   * everything else follows the policy's default chain, then the rest of the
   * registry. Membership is always re-checked against `eligibility`.
   */
  async resolveProviderIds(request: TRequest, flags?: unknown): Promise<string[]> {
    const spec = this.spec;
    const preferred = [...(spec.explicitPreference?.(request) ?? [])];
    if (preferred.length > 0 && spec.preferenceOnly) {
      // Dedup only — missing ids stay so the domain's execution loop can
      // report "provider 'x' is not registered" instead of a bare empty chain.
      return preferred.filter((id, index) => preferred.indexOf(id) === index);
    }
    const entry = resolveSeamSelectionEntry({
      seam: spec.seam,
      ...(spec.purpose?.(request) ? { purpose: spec.purpose(request) } : {}),
      ...(spec.context?.(request) ? { context: spec.context(request) } : {}),
      ...(spec.decisionKey?.(request) ? { decisionKey: spec.decisionKey(request) } : {}),
    });

    let lead: string[] = [];
    if (preferred.length === 0 && entry.kind === 'governed') {
      if (spec.governedScope !== 'lead' || entry.request.purpose) {
        return this.governedIds(request, entry.request);
      }
      lead = await this.ruleLead(request, entry.request);
    }

    const head = [...lead, ...preferred, ...this.defaultOrder(request)];
    const headSet = new Set(head);
    const candidates = await spec.eligibility(request, flags);
    const eligible = new Set(candidates.filter((c) => c.eligible).map((c) => c.id));
    let tail: string[];
    if (spec.registrationTail === false) {
      tail = [];
    } else if (spec.sortEligibleTail) {
      tail = [...eligible]
        .filter((id) => !headSet.has(id))
        .sort((left, right) => left.localeCompare(right));
    } else {
      tail = [...this.providers.keys()].filter((id) => !headSet.has(id));
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    const append = (id: string) => {
      if (seen.has(id) || !this.providers.has(id) || !eligible.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    for (const id of [...head, ...tail]) append(id);
    for (const id of spec.chainTail?.(ids, request) ?? []) append(id);
    return ids;
  }

  async resolveProviderChain(request: TRequest, flags?: unknown): Promise<TProvider[]> {
    const ids = await this.resolveProviderIds(request, flags);
    return ids.map((id) => this.providers.get(id)!);
  }
}
