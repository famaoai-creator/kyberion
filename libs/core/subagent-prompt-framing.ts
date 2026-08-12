/**
 * Shared prompt framing for delegated sub-agents (KD-05 / CT-01 / CN-02).
 *
 * These blocks are the governance framing every delegated sub-agent must
 * carry, regardless of how it is materialized:
 *
 *  - `scripts/generate_subagent_definitions.ts` writes them into the
 *    committed `.claude/agents/<role>.md` / `.agents/agents/<name>/agent.md`
 *    definitions (generation ceremony, drift-checked in CI);
 *  - `claude-native-subagent.ts` injects them into the runtime `--agents`
 *    JSON handed to a provider-native Claude CLI session.
 *
 * They live here (not in the generator) so both materializations quote the
 * same text — a committed definition and a runtime-injected one can never
 * disagree about what a sub-agent is allowed to do.
 */

/**
 * secure-io invariant (AGENTS.md §1) in sub-agent voice. Kept as one line so
 * the generated markdown and the runtime prompt are byte-identical.
 */
export const SUBAGENT_SECURE_IO_CONSTRAINT =
  'All file I/O goes through `@agent/core` secure-io helpers — never call `node:fs` directly. Write only within your assigned task scope; never mutate mission-wide or goal state directly. Prefer an existing `pnpm pipeline` or a typed CLI over ad-hoc file edits when one already covers the task (see `pipelines/README.md`, `CAPABILITIES_GUIDE.md`).';

/**
 * XP-04 §"The read/write matrix" projection. Canonical source of truth is
 * knowledge/product/governance/multi-provider-coexecution-contract.md — this
 * is a compressed, imperative-mood mirror of its 5 rows (same compression
 * AGENTS.md §1's "Multi-provider co-execution" bullet uses). If the
 * canonical doc's matrix changes, update it there first, then mirror the
 * change into these lines — this is the single location that needs editing.
 */
export const SUBAGENT_SHARED_DIRECTORY_RULES_LINES: readonly string[] = [
  '## Shared-directory rules (multi-provider co-execution)',
  '',
  'Other provider CLIs (`claude`, `codex`, `agy`, …) may be operating on this same checkout concurrently. Follow the read/write matrix:',
  '',
  '- Read any repo file freely — reads never race.',
  '- Write only what your active work-item claim covers — never a file outside your assignment scope.',
  "- Never touch `.git/` or repo config (`.gitignore`, workspace wiring, etc.) — that's the mission owner's, never a worker CLI's.",
  '- Temp files only under `active/shared/tmp/` (or mission-local storage) — never ad hoc directories.',
  '- Do not create or hand-edit provider state directories (`.claude/`, `.codex/`, `.agy/`, `.gemini/`, …) — they are gitignored and reproduced by generation ceremonies.',
  '',
  'Canonical contract: [multi-provider-coexecution-contract](../../knowledge/product/governance/multi-provider-coexecution-contract.md)',
  '',
];
