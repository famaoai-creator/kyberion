/**
 * KP-01: single entry point for task knowledge provisioning.
 *
 * MO-04 built the mission context pack (resolve → prune → render); its call
 * sites had drifted (`docs/developer/improvement-plans-2026-07/
 * TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md` §1.1): the single-shot
 * dispatch path resolved + saved + rendered inline, while the goal-driven
 * path (KD-01) never called any of it, leaving the most autonomous execution
 * mode the most knowledge-starved. `provisionTaskKnowledge` wraps
 * `resolveMissionContextPack` + `saveMissionContextPack` +
 * `renderMissionContextPack` (selection/budget/persistence logic is entirely
 * reused, never duplicated) behind one call whose only per-caller knob is the
 * rendering `form`:
 *
 * - `pack` — full rendered pack text. Byte-identical to calling
 *   `renderMissionContextPack` directly; this is the single-shot dispatch
 *   path's existing behavior, now just going through one seam.
 * - `system_prompt` — role-scoped, compact rendering meant to be passed once
 *   as `systemPrompt` to a goal-driven loop (`runGoalDrivenLoop` /
 *   `runGoalDrivenWorkItem`). KD-08 prompt-cache discipline: the loop treats
 *   `systemPrompt` as a stable prefix re-sent verbatim every turn, not
 *   content this module re-renders per turn — render once, pass once.
 * - `context_string` — compact context for `delegateTask`-style callers.
 *   KP-02 wires the actual callers (`background-review-runner.ts`,
 *   `adf-repair-agent.ts`); this only implements the rendering so KP-02 has
 *   something to call.
 *
 * Error contract: this function does not swallow errors — it mirrors
 * `resolveMissionContextPack`'s "null on missing/invalid mission state"
 * contract and otherwise propagates (e.g. an invalid-pack schema violation
 * from `buildMissionContextPack` still throws). That matches the single-shot
 * dispatch site's pre-existing behavior, which the caller wraps in its own
 * try/catch. Callers that need fail-open behavior (goal-driven dispatch, per
 * KP-01's acceptance criteria) wrap their own call site in try/catch and
 * proceed without a pack on failure — the goal loop already tolerates an
 * absent `systemPrompt`.
 */
import {
  renderMissionContextPack,
  resolveMissionContextPack,
  saveMissionContextPack,
  type MissionContextPack,
  type MissionContextPackKnowledgeHint,
  type ResolveMissionContextPackInput,
} from './mission-context-pack.js';

export type TaskKnowledgeForm = 'pack' | 'system_prompt' | 'context_string';

export interface ProvisionTaskKnowledgeInput extends ResolveMissionContextPackInput {
  /** Rendering form for the returned `text`. Defaults to `'pack'`. */
  form?: TaskKnowledgeForm;
  /** Mission directory to persist the resolved pack under. Omit to skip persistence. */
  missionPath?: string;
}

export interface ProvisionTaskKnowledgeResult {
  /** Null when `resolveMissionContextPack` could not resolve mission state; callers degrade/fail open. */
  pack: MissionContextPack | null;
  /** Rendered text in the requested form; `''` when `pack` is null. */
  text: string;
  /** Set only when `missionPath` was provided and the pack was persisted. */
  missionContextPackPath?: string;
}

function truncate(value: string, max: number): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function renderKnowledgeHintLines(
  hints: MissionContextPackKnowledgeHint[] | undefined,
  excerptMax: number
): string[] {
  if (!hints || hints.length === 0) return [];
  const lines: string[] = ['- Knowledge hints:'];
  for (const hint of hints) {
    lines.push(`  - ${hint.title} (${hint.path})`);
    lines.push(`    ${truncate(hint.excerpt, excerptMax)}`);
  }
  return lines;
}

/** Role-scoped, compact rendering meant to be sent once as a stable system-prompt prefix (KD-08). */
function renderSystemPromptForm(pack: MissionContextPack): string {
  const lines: string[] = [
    'Mission context (stable prefix — background for every turn, not a per-turn instruction).',
    `- Pack ID: ${pack.context_pack_id}`,
    `- Mission: ${pack.mission.mission_id} | ${pack.mission.status}${pack.mission.mission_type ? ` | type=${pack.mission.mission_type}` : ''}`,
    `- Recipient: ${pack.recipient.kind}${pack.recipient.team_role ? ` / role=${pack.recipient.team_role}` : ''}${pack.recipient.agent_id ? ` / agent=${pack.recipient.agent_id}` : ''}`,
  ];

  if (pack.work_item) {
    lines.push(
      `- Work item: ${pack.work_item.item_id} | ${pack.work_item.title}`,
      `  - Description: ${truncate(pack.work_item.description, 220)}`
    );
  }

  if (pack.task_guidance) {
    lines.push(
      '- Acceptance criteria:',
      ...pack.task_guidance.acceptance_criteria.map((criterion) => `  - ${criterion}`),
      `- Output contract: ${pack.task_guidance.output_contract}`
    );
  }

  lines.push(...renderKnowledgeHintLines(pack.knowledge_hints, 200));

  lines.push(
    '',
    'Use only the facts above and the objective/instructions given per turn. Report a gap instead of assuming facts outside this context.'
  );
  return lines.join('\n');
}

/** Compact context for delegateTask-style callers (KP-02 wires the actual callers). */
function renderContextStringForm(pack: MissionContextPack): string {
  const lines: string[] = [pack.summary];
  if (pack.work_item?.title) lines.push(`Work item: ${pack.work_item.title}`);
  if (pack.task_guidance?.acceptance_criteria.length) {
    lines.push(`Acceptance criteria: ${pack.task_guidance.acceptance_criteria.join('; ')}`);
  }
  if (pack.knowledge_hints && pack.knowledge_hints.length > 0) {
    lines.push(
      `Knowledge: ${pack.knowledge_hints.map((hint) => `${hint.title} (${hint.path})`).join('; ')}`
    );
  }
  return lines.join('\n');
}

function renderTaskKnowledgeForm(pack: MissionContextPack, form: TaskKnowledgeForm): string {
  switch (form) {
    case 'system_prompt':
      return renderSystemPromptForm(pack);
    case 'context_string':
      return renderContextStringForm(pack);
    case 'pack':
    default:
      return renderMissionContextPack(pack);
  }
}

/**
 * Resolve, persist, and render task knowledge for a dispatch call site. See
 * the module doc comment for the `form` contract and the error/fail-open
 * split between call sites.
 */
export async function provisionTaskKnowledge(
  input: ProvisionTaskKnowledgeInput
): Promise<ProvisionTaskKnowledgeResult> {
  const { form = 'pack', missionPath, ...resolveInput } = input;
  const pack = await resolveMissionContextPack(resolveInput);
  if (!pack) {
    return { pack: null, text: '' };
  }
  const missionContextPackPath = missionPath
    ? saveMissionContextPack(missionPath, pack)
    : undefined;
  const text = renderTaskKnowledgeForm(pack, form);
  return {
    pack,
    text,
    ...(missionContextPackPath ? { missionContextPackPath } : {}),
  };
}
