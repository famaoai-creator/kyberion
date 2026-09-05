/**
 * NI-03: explicit delegation chains.
 *
 * A {@link DelegationChain} is the ordered record of who delegated to whom,
 * root-first: `chain[0]` is the originating principal (a human `user:<id>`
 * or the orchestrator), and `chain[chain.length - 1]` is the actor most
 * recently granted work. Every hop (orchestrator → worker → sub-worker)
 * appends exactly one {@link DelegationLink}.
 *
 * ## RFC 8693 mapping (nested `act` claim)
 *
 * This is the internal, same-shape analogue of OAuth 2.0 Token Exchange's
 * delegation semantics (RFC 8693 §4.1): in a token, the top-level `act`
 * claim identifies the *current* acting party and each nested `act.act`
 * identifies a *prior* actor, ending at the original principal. Our
 * root-first array is that same structure read inside-out:
 *
 *   chain[n-1]  ≙  token `act`          (current actor)
 *   chain[n-2]  ≙  token `act.act`      (who delegated to the current actor)
 *   ...
 *   chain[0]    ≙  innermost actor / original `sub` (the root principal)
 *
 * Like RFC 8693 attenuation ("delegation MUST NOT expand privilege"), each
 * appended link's `granted_scope` must be a subset of its parent's — see
 * {@link validateChainAttenuation}. The projection seam to the external
 * standard is documented in the NHI plan (§2); no JWT encoding is performed
 * here.
 *
 * ## Attenuation semantics (child ⊆ parent, CO-06 delegation-lease vocabulary)
 *
 * Validation checks each link against its immediate parent. The root link is
 * trusted as given (it *defines* the outermost grant). Per dimension of
 * `granted_scope`:
 *
 * - **Absent parent field = unrestricted at that link** for that dimension:
 *   the child may declare anything (including nothing).
 * - **Present parent field + absent child field = violation**: absence
 *   consistently means "unrestricted", so a child that omits a dimension the
 *   parent restricted is claiming *more* than it was granted — fail-closed.
 * - `capability_tier`: compared via {@link CAPABILITY_TIER_PRIVILEGE} (see
 *   its doc for the KD-05 evidence). A child's privilege rank must be ≤ its
 *   parent's. Unknown tier names cannot be proven a subset → violation.
 * - `capabilities` / `write_scopes`: child array must be a subset (exact
 *   string membership) of the parent array.
 *
 * Attenuation violations are ALWAYS fail-closed ({@link assertChainAttenuation}
 * throws a typed {@link DelegationAttenuationError}) — a child requesting
 * more than its parent granted is a bug, not a policy choice. Chain
 * *presence*, by contrast, is optional everywhere: legacy chain-less paths
 * keep working unchanged.
 *
 * This module is deliberately dependency-free (pure data + logic) so that
 * light modules (mission-team-binding, a2a-bridge, agent-dispatch) can
 * import it without pulling in the policy engine / audit chain. Consistency
 * of {@link CAPABILITY_TIER_PRIVILEGE} with the KD-05 registry is enforced
 * by test (delegation-chain.test.ts) instead of by a runtime import.
 */

import { parseSafeJsonInput } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** KD-05 capability tier names (subagent-capability-profiles.ts registry). */
export type DelegationCapabilityTier = 'implementer' | 'explorer' | 'planner';

/**
 * Privilege ordering of the KD-05 capability tiers — higher number = MORE
 * privilege. Encoded from the actual profile registry
 * (libs/core/subagent-capability-profiles.ts, `SUBAGENT_CAPABILITY_PROFILES`):
 *
 * - `implementer`: `allowedOps: '*'` — full read/write/exec ("Full
 *   read/write/exec tier"). Most privileged.
 * - `explorer`: a finite read-only op list (`file:read`, searches, ...) —
 *   "must never change repository or knowledge state". Middle.
 * - `planner`: `allowedOps: []` — "no tool execution at all". Least
 *   privileged.
 *
 * NOTE this is the *privilege* order, not an org-chart order: a planner/
 * orchestrator ROLE sits high in the org hierarchy but its execution tier
 * can do the least. Attenuation compares what a tier can DO.
 */
export const CAPABILITY_TIER_PRIVILEGE: Readonly<Record<DelegationCapabilityTier, number>> = {
  planner: 0,
  explorer: 1,
  implementer: 2,
};

/**
 * What a delegation link grants its actor. Absent fields mean "unrestricted
 * at this link" for that dimension (see module doc for the child-side
 * consequence under a restricting parent).
 */
export type DelegationGrantedScope = {
  capability_tier?: DelegationCapabilityTier;
  capabilities?: string[];
  write_scopes?: string[];
};

/**
 * One hop of the delegation chain. `actor` is preferably a canonical nhi_id
 * (`kyberion://agent/<org>/<slug>`, NI-01) or `user:<id>`; legacy actor
 * strings are accepted so chains can be stamped before every path is
 * migrated to durable identities.
 */
export type DelegationLink = {
  actor: string;
  team_role?: string;
  granted_scope: DelegationGrantedScope;
  /** ISO-8601 timestamp of when this grant was made. */
  granted_at: string;
};

/** Ordered root-first; see module doc for the RFC 8693 mapping. */
export type DelegationChain = DelegationLink[];

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function copyGrantedScope(scope: DelegationGrantedScope | undefined): DelegationGrantedScope {
  if (!scope) return {};
  return {
    ...(scope.capability_tier !== undefined ? { capability_tier: scope.capability_tier } : {}),
    ...(scope.capabilities !== undefined ? { capabilities: [...scope.capabilities] } : {}),
    ...(scope.write_scopes !== undefined ? { write_scopes: [...scope.write_scopes] } : {}),
  };
}

/** Convenience constructor: defaults `granted_scope` to unrestricted and `granted_at` to now. */
export function buildDelegationLink(input: {
  actor: string;
  team_role?: string;
  granted_scope?: DelegationGrantedScope;
  granted_at?: string;
}): DelegationLink {
  const actor = String(input.actor || '').trim();
  if (!actor) throw new Error('[delegation-chain] a delegation link requires a non-empty actor');
  return {
    actor,
    ...(input.team_role ? { team_role: input.team_role } : {}),
    granted_scope: copyGrantedScope(input.granted_scope),
    granted_at: input.granted_at ?? nowIso(),
  };
}

/** Append a link, returning a NEW chain — never mutates the input chain (deep-copies the scope). */
export function appendDelegationLink(
  chain: DelegationChain,
  link: DelegationLink
): DelegationChain {
  return [...chain, { ...link, granted_scope: copyGrantedScope(link.granted_scope) }];
}

/** The originating principal of the chain (`chain[0].actor`), if any. */
export function delegationChainRootActor(chain: DelegationChain): string | undefined {
  return chain[0]?.actor;
}

// ---------------------------------------------------------------------------
// Attenuation validation (always fail-closed on explicit violations)
// ---------------------------------------------------------------------------

export interface ChainAttenuationResult {
  ok: boolean;
  violations: string[];
}

function isKnownTier(tier: string): tier is DelegationCapabilityTier {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_TIER_PRIVILEGE, tier);
}

function checkSubsetList(
  dimension: 'capabilities' | 'write_scopes',
  parent: DelegationGrantedScope,
  child: DelegationGrantedScope,
  index: number,
  violations: string[]
): void {
  const parentList = parent[dimension];
  if (parentList === undefined) return; // absent parent field = unrestricted
  const childList = child[dimension];
  if (childList === undefined) {
    violations.push(
      `link[${index}] omits ${dimension} (= unrestricted) while its parent restricts to [${parentList.join(', ')}]`
    );
    return;
  }
  const allowed = new Set(parentList);
  const excess = childList.filter((entry) => !allowed.has(entry));
  if (excess.length > 0) {
    violations.push(
      `link[${index}] ${dimension} [${excess.join(', ')}] exceed the parent grant [${parentList.join(', ')}]`
    );
  }
}

/**
 * Validate that every non-root link's `granted_scope` is a subset of its
 * parent's (child ≤ parent). See the module doc for per-dimension rules.
 */
export function validateChainAttenuation(chain: DelegationChain): ChainAttenuationResult {
  const violations: string[] = [];
  for (let i = 1; i < chain.length; i += 1) {
    const parent = chain[i - 1]?.granted_scope ?? {};
    const child = chain[i]?.granted_scope ?? {};

    if (parent.capability_tier !== undefined) {
      if (!isKnownTier(parent.capability_tier)) {
        violations.push(
          `link[${i - 1}] has unknown capability_tier "${parent.capability_tier}" — cannot prove attenuation`
        );
      } else if (child.capability_tier === undefined) {
        violations.push(
          `link[${i}] omits capability_tier (= unrestricted) while its parent restricts to "${parent.capability_tier}"`
        );
      } else if (!isKnownTier(child.capability_tier)) {
        violations.push(
          `link[${i}] has unknown capability_tier "${child.capability_tier}" — cannot prove attenuation`
        );
      } else if (
        CAPABILITY_TIER_PRIVILEGE[child.capability_tier] >
        CAPABILITY_TIER_PRIVILEGE[parent.capability_tier]
      ) {
        violations.push(
          `link[${i}] capability_tier "${child.capability_tier}" outranks the parent grant "${parent.capability_tier}"`
        );
      }
    }

    checkSubsetList('capabilities', parent, child, i, violations);
    checkSubsetList('write_scopes', parent, child, i, violations);
  }
  return { ok: violations.length === 0, violations };
}

/** Typed fail-closed error for attenuation violations (and malformed chains at guarded seams). */
export class DelegationAttenuationError extends Error {
  constructor(public readonly violations: string[]) {
    super(
      `[delegation-chain] attenuation violation — a delegated grant may never exceed its parent: ${violations.join('; ')}`
    );
    this.name = 'DelegationAttenuationError';
  }
}

/** Throw {@link DelegationAttenuationError} unless the chain attenuates correctly. */
export function assertChainAttenuation(chain: DelegationChain): void {
  const result = validateChainAttenuation(chain);
  if (!result.ok) throw new DelegationAttenuationError(result.violations);
}

// ---------------------------------------------------------------------------
// Serialization (contract payloads, A2A headers, ledger entries)
// ---------------------------------------------------------------------------

/** Compact JSON serialization for header/contract embedding. */
export function serializeDelegationChain(chain: DelegationChain): string {
  return JSON.stringify(chain);
}

function parseLink(value: unknown): DelegationLink | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actor = typeof record.actor === 'string' ? record.actor.trim() : '';
  if (!actor) return null;
  if (typeof record.granted_at !== 'string' || !record.granted_at.trim()) return null;
  if (record.team_role !== undefined && typeof record.team_role !== 'string') return null;
  const scopeRaw = record.granted_scope;
  if (!scopeRaw || typeof scopeRaw !== 'object' || Array.isArray(scopeRaw)) return null;
  const scope = scopeRaw as Record<string, unknown>;
  const grantedScope: DelegationGrantedScope = {};
  if (scope.capability_tier !== undefined) {
    if (typeof scope.capability_tier !== 'string' || !isKnownTier(scope.capability_tier)) {
      return null;
    }
    grantedScope.capability_tier = scope.capability_tier;
  }
  for (const dimension of ['capabilities', 'write_scopes'] as const) {
    const list = scope[dimension];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) return null;
    grantedScope[dimension] = [...(list as string[])];
  }
  return {
    actor,
    ...(record.team_role ? { team_role: record.team_role as string } : {}),
    granted_scope: grantedScope,
    granted_at: record.granted_at,
  };
}

/**
 * Parse a chain from a serialized string or a structured array. Returns
 * `null` on anything malformed (empty chains parse as `[]`). Never throws —
 * guarded seams decide whether a malformed chain is fail-closed
 * (dispatch/route: yes) or best-effort-dropped (audit attribution).
 */
export function parseDelegationChain(value: unknown): DelegationChain | null {
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = parseSafeJsonInput(candidate, 'delegation chain');
    } catch {
      return null;
    }
  }
  if (!Array.isArray(candidate)) return null;
  const links: DelegationLink[] = [];
  for (const entry of candidate) {
    const link = parseLink(entry);
    if (!link) return null;
    links.push(link);
  }
  return links;
}

// ---------------------------------------------------------------------------
// Context-string embedding (agent-dispatch seam)
// ---------------------------------------------------------------------------
//
// `ReasoningBackend.delegateTask(instruction, context)` carries context as a
// plain string, so the chain travels between dispatch hops inside a marked
// block. The dispatch layer (agent-dispatch.ts) extracts the block, appends
// the next hop's link, and re-embeds the updated chain — nothing else
// interprets the markers.

export const DELEGATION_CHAIN_CONTEXT_OPEN = '<delegation-chain>';
export const DELEGATION_CHAIN_CONTEXT_CLOSE = '</delegation-chain>';

const CONTEXT_BLOCK_PATTERN = new RegExp(
  `\\n?${DELEGATION_CHAIN_CONTEXT_OPEN}([\\s\\S]*?)${DELEGATION_CHAIN_CONTEXT_CLOSE}`
);

/** Append the serialized chain to a context string as a marked block. */
export function embedDelegationChainInContext(
  context: string | undefined,
  chain: DelegationChain
): string {
  const block = `${DELEGATION_CHAIN_CONTEXT_OPEN}${serializeDelegationChain(chain)}${DELEGATION_CHAIN_CONTEXT_CLOSE}`;
  return context ? `${context}\n${block}` : block;
}

export interface ExtractedDelegationChainContext {
  /** Parsed chain, or null when no block is present OR the block is malformed. */
  chain: DelegationChain | null;
  /** True when a block was present but did not parse — callers at guarded seams fail closed. */
  malformed: boolean;
  /** The context with the chain block removed (unchanged when no block). */
  contextWithoutChain: string | undefined;
}

/** Extract (and strip) an embedded delegation-chain block from a context string. */
export function extractDelegationChainFromContext(
  context: string | undefined
): ExtractedDelegationChainContext {
  if (!context) return { chain: null, malformed: false, contextWithoutChain: context };
  const match = context.match(CONTEXT_BLOCK_PATTERN);
  if (!match) return { chain: null, malformed: false, contextWithoutChain: context };
  const stripped = context.replace(CONTEXT_BLOCK_PATTERN, '').trim();
  const contextWithoutChain = stripped.length > 0 ? stripped : undefined;
  const chain = parseDelegationChain(match[1]);
  return { chain, malformed: chain === null, contextWithoutChain };
}
