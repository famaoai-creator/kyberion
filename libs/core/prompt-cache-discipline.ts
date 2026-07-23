/**
 * Prompt-Cache Discipline Contract (KD-08) — codifies the stable-prefix
 * invariant the API-direct backends (`anthropic-reasoning-backend.ts`,
 * `openai-compatible-backend.ts`) must hold for the provider's prompt cache
 * to ever hit. Modeled on kimi-code's cache-first design: system prompt +
 * tool declarations are an immutable prefix for the life of a conversation,
 * and even a "cheap" mid-history edit is rejected once its cache-invalidation
 * cost is understood.
 *
 * Four rules, matching KIMI_CODE_ADOPTION_PLAN_2026-07-20.ja.md §3 KD-08:
 *
 * 1. **Stable-prefix invariant** — system prompt + tool declaration list must
 *    not mutate mid-turn. `StablePrefixGuard` enforces this with an
 *    assertion that throws the moment a caller would break it;
 *    `renderDeferredToolAnnouncement` is the prefix-safe way to make a new
 *    tool available without touching the `tools` array (a message-level
 *    announcement instead of a structural edit — kimi-code's
 *    `Tool.deferred` pattern).
 * 2. **Cache breakpoints** — `applyCacheBreakpointToSystemBlocks` /
 *    `ToTools` / `ToLastMessage` place `cache_control: {type:'ephemeral'}`
 *    at the three stable-prefix boundaries Anthropic actually reads from:
 *    the last system block, the last tool declaration, and the last
 *    message's last content block. Anthropic's cache covers everything up
 *    to and including a marked block, so marking only the last one per
 *    region is both sufficient and stays inside the 4-breakpoint request
 *    limit.
 * 3. **Closed prefix while a tool call is in flight** — a dispatched tool
 *    call and its (possibly delayed) result must never touch system/tools;
 *    only the message array is allowed to grow while a round-trip is
 *    outstanding. `StablePrefixGuard.assertStable` is the enforcement point
 *    a tool loop calls on every iteration.
 * 4. **Mid-history mutation is out of scope on purpose.** kimi-code shipped
 *    and then disabled a "micro-compaction" pass that rewrote older turns
 *    in place, because the cache-invalidation cost of touching anything
 *    before the tail outweighed the tokens it saved. Kyberion's OH-01
 *    compaction (`worker-context-compaction.ts`) already only runs at
 *    conversation boundaries — a full re-summarization, not an in-place
 *    edit — so this module does not add a competing mid-history editor.
 *    `StablePrefixGuard.reset()` exists only to be called from that
 *    boundary (see `notifyAllDynamicInjectionRegistries` call site in
 *    `worker-context-compaction.ts` for the analogous KC-08 reset hook),
 *    never from inside a turn.
 */

/** Deterministic, key-sorted JSON — the same "canonical JSON" shape KC-01's
 * `tool-loop-guardrail.ts` uses for tool-call signatures, so the two
 * invariants agree on what "the same shape" means. Kept local rather than
 * imported to avoid coupling an unrelated guardrail module to this contract. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface StablePrefixSnapshot {
  /** System prompt blocks (or a plain string) exactly as sent to the provider. */
  system?: unknown;
  /** Tool declarations exactly as sent to the provider (name/description/schema). */
  tools?: unknown;
}

/**
 * Canonical byte sequence for the stable prefix — the same string this
 * module's tests assert is unchanged across turns ("golden" byte-sequence
 * check), and the comparison key `StablePrefixGuard` uses internally.
 * `cache_control` markers are intentionally excluded from the comparison
 * (see `applyCacheBreakpointTo*`): they are metadata about caching, not part
 * of the semantic prefix, and are expected to be (re-)applied on every call.
 */
export function computeStablePrefixFingerprint(snapshot: StablePrefixSnapshot): string {
  return canonicalJson({
    system: stripCacheControl(snapshot.system ?? null),
    tools: stripCacheControl(snapshot.tools ?? null),
  });
}

function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (value && typeof value === 'object') {
    const { cache_control: _cacheControl, ...rest } = value as Record<string, unknown>;
    for (const key of Object.keys(rest)) rest[key] = stripCacheControl(rest[key]);
    return rest;
  }
  return value;
}

export class PromptCachePrefixMutationError extends Error {
  constructor(reason: string) {
    super(`[PROMPT_CACHE_PREFIX_MUTATED] ${reason}`);
    this.name = 'PromptCachePrefixMutationError';
  }
}

/**
 * Enforces the KD-08 stable-prefix invariant across the turns of one
 * conversation: system prompt + tool declarations must not change once the
 * first turn has recorded a baseline, because the provider's prompt cache is
 * keyed on the verbatim byte prefix. A caller that legitimately needs the
 * prefix to change (an OH-01 full-summarization compaction boundary) must
 * call `reset()` to accept a new baseline — see the module doc comment for
 * why mid-history mutation is not an escape hatch.
 *
 * Kyberion's current backends never add tools mid-turn (checked against
 * `anthropic-reasoning-backend.ts` and `openai-compatible-backend.ts` as of
 * this contract), so in production this guard should never throw. It exists
 * so a future change that does mutate the prefix mid-turn fails loudly in
 * tests/dev instead of silently paying for a cold cache on every call.
 */
export class StablePrefixGuard {
  private baseline: string | undefined;

  /**
   * Records the fingerprint on the first call after construction/reset;
   * throws `PromptCachePrefixMutationError` if a later call's fingerprint
   * differs from that baseline.
   */
  assertStable(snapshot: StablePrefixSnapshot): void {
    const fingerprint = computeStablePrefixFingerprint(snapshot);
    if (this.baseline === undefined) {
      this.baseline = fingerprint;
      return;
    }
    if (fingerprint !== this.baseline) {
      throw new PromptCachePrefixMutationError(
        'system prompt + tool declarations changed mid-turn. Use a message-level ' +
          'deferred announcement (renderDeferredToolAnnouncement) to make a new tool ' +
          'available without editing the stable tools array, or wait for the next ' +
          'context-compaction boundary and call reset() there instead of mutating the ' +
          'prefix in place.'
      );
    }
  }

  /** True once a baseline has been recorded (i.e. at least one turn has run). */
  get hasBaseline(): boolean {
    return this.baseline !== undefined;
  }

  /** Accept a new baseline — call only from a stable-prefix boundary (e.g. OH-01 compaction). */
  reset(): void {
    this.baseline = undefined;
  }
}

// ---------------------------------------------------------------------------
// Rule 1 (safe path): message-level / deferred tool declarations
// ---------------------------------------------------------------------------

export interface DeferredToolDeclaration {
  name: string;
  description: string;
}

/**
 * Renders newly-available tools as a message-level announcement instead of
 * inserting them into the stable `tools` array declared at the top of the
 * request. Mutating that array mid-turn moves every subsequent byte in the
 * prefix and invalidates the cache from that point on — appending to the end
 * of the array is not safe either, since providers key the cache on the
 * verbatim tool list and a retried request would still diverge from what was
 * cached for the in-flight turn.
 *
 * The declaration is described in prose; the model can still ask for it by
 * name in a normal text/tool_use exchange, and the actual schema-declared
 * tool is only added to the stable `tools` array at the next stable-prefix
 * boundary (see `promoteDeferredToolDeclarations`), matching kimi-code's
 * `Tool.deferred` pattern and rule 4 above.
 */
export function renderDeferredToolAnnouncement(
  tools: readonly DeferredToolDeclaration[]
): string | null {
  if (tools.length === 0) return null;
  return [
    'New capability available starting this turn. It is not yet declared in the',
    'tool schema — describe your intended call in prose and it will be promoted',
    'to a schema-declared tool at the next context boundary:',
    ...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
  ].join('\n');
}

/**
 * Folds deferred tool declarations into the stable tools array. Call only at
 * a stable-prefix boundary (alongside `StablePrefixGuard.reset()`) — calling
 * this mid-turn defeats the entire point of deferring the addition.
 */
export function promoteDeferredToolDeclarations<T>(
  stableTools: readonly T[],
  deferred: readonly T[]
): T[] {
  return [...stableTools, ...deferred];
}

// ---------------------------------------------------------------------------
// Rule 2: Anthropic cache_control breakpoint placement
// ---------------------------------------------------------------------------

const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' as const };

/**
 * Generic constraints below use bare `object` rather than an explicit
 * `{ cache_control?: unknown }` shape. TypeScript's "weak type" excess-
 * property detection flags any object literal with nothing in common with an
 * all-optional-properties type, so constraining on the (all-optional)
 * cache_control field itself makes every real call site (whose literals
 * never declare `cache_control` up front — that is the point of this
 * module) fail to type-check. `object` avoids that false positive while
 * still preventing primitives from being passed in.
 */

/** Marks the last system text block as a cache breakpoint. Pure — never mutates the input. */
export function applyCacheBreakpointToSystemBlocks<T extends object>(
  blocks: readonly T[]
): Array<T & { cache_control?: typeof EPHEMERAL_CACHE_CONTROL }> {
  if (blocks.length === 0) return [];
  return blocks.map((block, index) =>
    index === blocks.length - 1
      ? { ...block, cache_control: EPHEMERAL_CACHE_CONTROL }
      : { ...block }
  );
}

/** Marks the last tool declaration as a cache breakpoint. Pure — never mutates the input. */
export function applyCacheBreakpointToTools<T extends object>(
  tools: readonly T[]
): Array<T & { cache_control?: typeof EPHEMERAL_CACHE_CONTROL }> {
  if (tools.length === 0) return [];
  return tools.map((tool, index) =>
    index === tools.length - 1 ? { ...tool, cache_control: EPHEMERAL_CACHE_CONTROL } : { ...tool }
  );
}

interface CacheableMessage {
  role: string;
  content: string | ReadonlyArray<object>;
}

/**
 * Marks the last content block of the last message as a cache breakpoint. A
 * string `content` is promoted to a single-block text array so it can carry
 * the marker (Anthropic's `cache_control` is a content-block-level field).
 * Pure — never mutates the input. The string→array promotion is a runtime-only
 * shape change (both forms are valid Anthropic message content); the result
 * is cast back to `M` so callers keep working with their own declared
 * message type instead of a synthetic union.
 */
export function applyCacheBreakpointToLastMessage<M extends CacheableMessage>(
  messages: readonly M[]
): M[] {
  if (messages.length === 0) return [];
  const result = messages.map((message, index) => {
    if (index !== messages.length - 1) return { ...message };
    if (typeof message.content === 'string') {
      return {
        ...message,
        content: [{ type: 'text', text: message.content, cache_control: EPHEMERAL_CACHE_CONTROL }],
      };
    }
    if (!Array.isArray(message.content) || message.content.length === 0) return { ...message };
    const blocks = message.content;
    return {
      ...message,
      content: blocks.map((block, blockIndex) =>
        blockIndex === blocks.length - 1
          ? { ...block, cache_control: EPHEMERAL_CACHE_CONTROL }
          : { ...block }
      ),
    };
  });
  return result as unknown as M[];
}
