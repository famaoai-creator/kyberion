import {
  logger,
  missionDir,
  sendOpsAlert,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  pathResolver,
  resolveVars,
  getReasoningBackend,
  getVoiceBridge,
  getSpeechToTextBridge,
  consumeTenantBudget,
  TenantRateLimitExceededError,
  findRelevantDistilledKnowledge,
  formatDistilledKnowledgeSummary,
  listDistillCandidateRecords,
  registerPresentationPreferenceProfile,
  type PresentationPreferenceProfile,
  resolveReasoningParticipant,
  renderReasoningParticipantContext,
  validateContextOutputTier,
  type GovernedContextFragment,
  type ReasoningParticipant,
  resolveGoldenRulePriorityOrder,
  resolveVision,
  type GoldenRulePriority,
  curateBackgroundReviewProposals,
} from '@agent/core';
import * as path from 'node:path';
import { assignWisdomContextValue, mergeWisdomContext } from './contracts/wisdom-context.js';
import { forwardWisdomBoundaryOperation } from './compatibility/cross-actuator-forwarders.js';
import {
  proposeToolCalls,
  runPeerAdvice,
  runPureReasoning,
  runReasoningLoop,
} from './reasoning/reasoning-ops.js';
import {
  computeReadinessMatrix,
  recommend,
  stakeholderGridSort,
} from './decision-support/stakeholder-ops.js';
export {
  computeReadinessMatrix,
  recommend,
  stakeholderGridSort,
} from './decision-support/stakeholder-ops.js';

/**
 * Decision-support operations for Kyberion.
 *
 * Implements the runtime for the protocols in:
 *   knowledge/product/orchestration/{hypothesis-tree,counterfactual-simulation,
 *   stakeholder-consensus,negotiation,rehearsal,real-time-coaching,
 *   intuition-capture,relationship-graph}-protocol.md
 *
 * Pure-logic ops (unchanged since they do not need a model):
 *   - stakeholder_grid_sort
 *   - emit_dissent_log
 *   - compute_readiness_matrix
 *   - recommend
 *   - adjust_proposal (append-only; semantic adjustment delegates upward)
 *   - extract_dissent_signals (pass-through normalisation)
 *
 * LLM-dependent ops delegate to `@agent/core` reasoning-backend contract
 * (`getReasoningBackend()` → divergePersonas / crossCritique /
 * synthesizePersona / forkBranches / simulateBranches):
 *   - a2a_fanout, cross_critique, synthesize_counterparty_persona
 *   - fork_branches, simulate_all
 *
 * Voice-dependent ops delegate to `@agent/core` voice-bridge contract
 * (`getVoiceBridge()` → runRoleplaySession / runOneOnOneSession):
 *   - a2a_roleplay, conduct_1on1
 *
 * Whether the output is a real model run or a placeholder depends on
 * which backend / bridge is registered at runtime. Deployments without
 * a registered backend still produce well-formed (marked `_synthetic`
 * where relevant) output so pipelines stay dry-runnable.
 */

type Ctx = Record<string, any>;

function readResolvedPath(rel: string): string {
  const abs = pathResolver.rootResolve(rel);
  return safeReadFile(abs, { encoding: 'utf8' }) as string;
}

function readJSON<T = any>(rel: string): T {
  return JSON.parse(readResolvedPath(rel)) as T;
}

function writeJSON(rel: string, data: any): string {
  const abs = pathResolver.rootResolve(rel);
  const dir = path.dirname(abs);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(abs, JSON.stringify(data, null, 2));
  return abs;
}

function nowIso(): string {
  return new Date().toISOString();
}

function deriveReasoningMode(backendName: string, synthetic = false): 'placeholder' | 'model' {
  if (synthetic) return 'placeholder';
  const normalized = String(backendName || '').toLowerCase();
  return normalized === 'stub' || normalized.endsWith('-stub') ? 'placeholder' : 'model';
}

function generateHeuristicId(): string {
  // Short ULID-ish id: time-ordered, url-safe.
  const time = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `HEU-${time}-${rand}`;
}

// ---------------------------------------------------------------------------
// Presentation Preference Registration — extracted deck style → reusable
// personal registry entry. This keeps theme hints and question prompts out of
// the code path and lets media-actuator resolve the theme from the personal
// overlay catalog.
// ---------------------------------------------------------------------------

export interface RegisterPresentationPreferenceProfileOpInput {
  profile?: PresentationPreferenceProfile;
  profile_path?: string;
  registry_path?: string;
}

export async function registerPresentationPreferenceProfileOp(
  input: RegisterPresentationPreferenceProfileOpInput
): Promise<{
  profile_id: string;
  registry_path: string;
  default_profile_id: string;
}> {
  const profile =
    input.profile ??
    (input.profile_path && safeExistsSync(pathResolver.rootResolve(input.profile_path))
      ? JSON.parse(
          safeReadFile(pathResolver.rootResolve(input.profile_path), { encoding: 'utf8' }) as string
        )
      : null);
  if (!profile || typeof profile !== 'object') {
    throw new Error(
      '[register_presentation_preference_profile] requires a presentation-preference-profile'
    );
  }

  const registryPath = registerPresentationPreferenceProfile(
    profile as PresentationPreferenceProfile,
    input.registry_path ? pathResolver.rootResolve(input.registry_path) : undefined
  );

  return {
    profile_id: (profile as PresentationPreferenceProfile).profile_id,
    registry_path: registryPath,
    default_profile_id: (profile as PresentationPreferenceProfile).profile_id,
  };
}

// ---------------------------------------------------------------------------
// Intuition Capture — records a 3-question heuristic entry under the
// confidential tier. See knowledge/product/orchestration/intuition-capture-protocol.md.
// No LLM needed; the capture is a structured record of the Sovereign's answers.
// ---------------------------------------------------------------------------

export interface CaptureIntuitionInput {
  decision: string;
  anchor: string;
  analogy: string;
  vetoed_options?: string[];
  mission_id?: string;
  trigger?: 'five_second_rule' | 'explicit_gut_flag' | 'tonal_detection';
  tags?: string[];
}

export function captureIntuition(input: CaptureIntuitionInput): {
  id: string;
  written_to: string;
} {
  if (!input.decision || !input.anchor || !input.analogy) {
    throw new Error(
      '[capture_intuition] requires decision, anchor, and analogy (the three Intuition Capture answers)'
    );
  }
  const id = generateHeuristicId();
  const entry: Record<string, unknown> = {
    id,
    captured_at: nowIso(),
    decision: input.decision,
    anchor: input.anchor,
    analogy: input.analogy,
  };
  if (input.vetoed_options && input.vetoed_options.length > 0) {
    entry.vetoed_options = input.vetoed_options;
  }
  if (input.mission_id) entry.mission_id = input.mission_id;
  if (input.trigger) entry.trigger = input.trigger;
  if (input.tags && input.tags.length > 0) entry.tags = input.tags;

  const relPath = `knowledge/confidential/heuristics/${id}.json`;
  writeJSON(relPath, entry);
  return { id, written_to: relPath };
}

// NOTE: LLM/voice-dependent ops now delegate to reasoning-backend / voice-bridge.
// The backends are responsible for their own provenance signalling (engine_id,
// _synthetic, warn logs when unregistered). The warnStub helper is preserved
// for call sites that still need to mark bespoke stub paths.
function warnStub(op: string, note?: string): void {
  logger.warn(
    `[DECISION_OPS:STUB] ${op} executed in stub mode${note ? ` — ${note}` : ''}. Replace with LLM/voice integration before production use.`
  );
}

// ---------------------------------------------------------------------------
// Pure-logic ops
// ---------------------------------------------------------------------------

/**
 * Emit dissent log from a hypothesis tree or arbitrary source with {hypotheses}.
 * Filters hypotheses with `status === 'rejected'` (or falsy `survived`) and
 * writes a schema-conformant dissent-log.json.
 */
export function emitDissentLog(input: {
  source_path: string;
  output_path: string;
  append?: boolean;
  mission_id?: string;
  topic?: string;
}): { written_to: string; count: number } {
  const src = readJSON<any>(input.source_path);
  const pool: any[] = src.hypotheses || src.items || [];

  const rejected = pool.filter((h) => {
    if (h.status) return h.status === 'rejected';
    if (typeof h.survived === 'boolean') return !h.survived;
    return false;
  });

  const dissents = rejected.map((h) => ({
    hypothesis: h.content || h.hypothesis || h.summary || JSON.stringify(h),
    proposed_by: h.proposed_by || h.persona || 'unknown',
    rejection_reason: h.rejection_reason || h.critique || 'not-provided',
    rejection_confidence: h.rejection_confidence || 'medium',
    revisit_triggers: h.revisit_triggers || [],
    evidence_refs: h.evidence_refs || [],
  }));

  let existing: any = null;
  if (input.append && safeExistsSync(pathResolver.rootResolve(input.output_path))) {
    existing = readJSON(input.output_path);
  }

  const payload = existing
    ? { ...existing, dissents: [...(existing.dissents || []), ...dissents] }
    : {
        mission_id: input.mission_id || src.mission_id || 'unknown',
        topic: input.topic || src.topic || 'unspecified',
        dissents,
        created_at: nowIso(),
      };

  writeJSON(input.output_path, payload);
  return { written_to: input.output_path, count: dissents.length };
}

/**
 * Render hypothesis-tree.json (post cross-critique) as a human-readable
 * Markdown report. Groups by proposed_by persona, shows critiques + status,
 * and emits a final summary of survived vs rejected counts.
 */
export function renderHypothesisReport(input: {
  source_path: string;
  output_path: string;
  title?: string;
}): { written_to: string; sections: number } {
  const src = readJSON<any>(input.source_path);
  const topic: string = src.topic || '';
  const hypotheses: any[] = src.hypotheses || [];
  const generatedBy: string = src.generated_by || 'unknown';
  const generatedAt: string = src.generated_at || '';

  const byPersona = new Map<string, any[]>();
  for (const h of hypotheses) {
    const key = h.proposed_by || 'unknown';
    if (!byPersona.has(key)) byPersona.set(key, []);
    byPersona.get(key)!.push(h);
  }

  const survivedCount = hypotheses.filter((h) => h.survived === true).length;
  const rejectedCount = hypotheses.filter((h) => h.survived === false).length;
  const pendingCount = hypotheses.length - survivedCount - rejectedCount;

  const lines: string[] = [];
  lines.push(`# ${input.title || 'Hypothesis Tree Report'}`);
  lines.push('');
  lines.push(`**Topic**: ${topic}`);
  lines.push('');
  lines.push('## Metadata');
  lines.push('');
  lines.push(`- Generated by: \`${generatedBy}\``);
  if (generatedAt) lines.push(`- Generated at: ${generatedAt}`);
  lines.push(`- Personas: ${byPersona.size}`);
  lines.push(`- Total hypotheses: ${hypotheses.length}`);
  lines.push(
    `- Survived: ${survivedCount} / Rejected: ${rejectedCount} / Pending: ${pendingCount}`
  );
  lines.push('');

  lines.push('## Hypotheses by persona');
  lines.push('');
  const personaEntries = Array.from(byPersona.entries());
  for (const [persona, items] of personaEntries) {
    lines.push(`### ${persona}`);
    lines.push('');
    for (const h of items) {
      const statusEmoji = h.survived === true ? '✅' : h.survived === false ? '❌' : '⏳';
      lines.push(`#### ${statusEmoji} ${h.id || '(no-id)'}`);
      lines.push('');
      lines.push(h.content || '(no content)');
      lines.push('');
      if (h.survived === false && h.rejection_reason) {
        lines.push(`> **Rejected because**: ${h.rejection_reason}`);
        lines.push('');
      }
      if (Array.isArray(h.critiques) && h.critiques.length > 0) {
        lines.push('**Critiques:**');
        lines.push('');
        for (const c of h.critiques) {
          lines.push(`- *by ${c.by || 'unknown'}*: ${c.content || ''}`);
        }
        lines.push('');
      }
    }
  }

  lines.push('## Summary');
  lines.push('');
  if (survivedCount > 0) {
    lines.push(
      `${survivedCount} hypothes${survivedCount === 1 ? 'is' : 'es'} survived cross-critique and warrant further investigation.`
    );
  }
  if (rejectedCount > 0) {
    lines.push(
      `${rejectedCount} hypothes${rejectedCount === 1 ? 'is was' : 'es were'} rejected — see \`dissent-log.json\` for revisit triggers.`
    );
  }
  if (pendingCount > 0) {
    lines.push(
      `${pendingCount} hypothes${pendingCount === 1 ? 'is remains' : 'es remain'} pending (no critique pass yet).`
    );
  }
  lines.push('');

  safeMkdir(path.dirname(pathResolver.rootResolve(input.output_path)), { recursive: true });
  safeWriteFile(pathResolver.rootResolve(input.output_path), lines.join('\n'));
  return { written_to: input.output_path, sections: personaEntries.length };
}

/**
 * CO-04 Task 3: when hypothesis-tree convergence (hypothesis-tree-protocol.md
 * Phase C) leaves more than one hypothesis surviving critique, decide between
 * them deterministically using the vision's golden-rule priority order
 * (Logical Integrity > Vision Alignment > Execution Speed > Adaptive
 * Resilience by default) instead of an arbitrary pick. A candidate without a
 * declared golden_rule_dimension ranks last — omission must not win a
 * tie-break by default.
 */
export function resolveHypothesisConflict(input: {
  source_path: string;
  tenant_slug?: string | null;
  output_path: string;
}): {
  winner_id: string | null;
  conflict: boolean;
  survivor_count: number;
  golden_rule_priority: GoldenRulePriority[];
  written_to: string;
} {
  const src = readJSON<any>(input.source_path);
  const hypotheses: any[] = Array.isArray(src.hypotheses) ? src.hypotheses : [];
  const survivors = hypotheses.filter((h) => h.survived === true);

  const priority = resolveGoldenRulePriorityOrder(resolveVision(input.tenant_slug ?? null));
  const dimensionRank = (h: any): number => {
    const dimension = typeof h.golden_rule_dimension === 'string' ? h.golden_rule_dimension : null;
    const idx = dimension ? priority.indexOf(dimension as GoldenRulePriority) : -1;
    return idx === -1 ? priority.length : idx;
  };

  const conflict = survivors.length > 1;
  const winner = conflict
    ? [...survivors].sort((a, b) => dimensionRank(a) - dimensionRank(b))[0]
    : (survivors[0] ?? null);

  const result = {
    winner_id: winner?.id ?? null,
    conflict,
    survivor_count: survivors.length,
    golden_rule_priority: priority,
    resolved_at: nowIso(),
  };
  writeJSON(input.output_path, result);
  return { ...result, written_to: input.output_path };
}

/**
 * Append-only proposal adjustment. Records new signals as a trailing
 * "Updates" section on the proposal file. Semantic rewording requires an LLM
 * and is not attempted here.
 */
export function adjustProposalAppend(input: {
  proposal_path: string;
  signals: any;
  output_path?: string;
}): { written_to: string } {
  const original = readResolvedPath(input.proposal_path);
  const block = `\n\n---\n### Updates (${nowIso()})\n\n\`\`\`json\n${JSON.stringify(input.signals, null, 2)}\n\`\`\`\n`;
  const out = input.output_path || input.proposal_path;
  const abs = pathResolver.rootResolve(out);
  const dir = path.dirname(abs);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(abs, original + block);
  return { written_to: out };
}

/**
 * Scan extracted slides and return the 1-based indices whose text contains
 * any of the supplied owner labels (e.g. "報告担当A"). Exact substring match.
 *
 * Input shape: output of media-actuator's `pptx_slide_text` op
 *   (array of { slide_index, concatenated, ... }).
 *
 * This is the missing piece for "give me a template, I'll give you back only
 * my slides": the agent calls pptx_slide_text, then this op, then pptx_filter_slides.
 */
export function findSlidesByOwner(input: {
  slides: Array<{ slide_index: number; concatenated?: string; text_runs?: string[] }>;
  owner_labels: string[];
  match_mode?: 'substring' | 'run_exact';
}): { indices: number[]; matches: Array<{ slide_index: number; matched_label: string }> } {
  const mode = input.match_mode || 'substring';
  const matches: Array<{ slide_index: number; matched_label: string }> = [];

  for (const slide of input.slides) {
    for (const label of input.owner_labels) {
      const hit =
        mode === 'substring'
          ? (slide.concatenated || '').includes(label)
          : (slide.text_runs || []).includes(label);
      if (hit) {
        matches.push({ slide_index: slide.slide_index, matched_label: label });
        break;
      }
    }
  }

  const indices = matches.map((m) => m.slide_index);
  return { indices, matches };
}

/**
 * Diff two extracted slide sets and return a structured change report.
 * Compares concatenated text per slide_index. Slides present in only one
 * side are reported as added/removed.
 */
export function pptxDiff(input: {
  before: Array<{ slide_index: number; concatenated?: string; text_runs?: string[] }>;
  after: Array<{ slide_index: number; concatenated?: string; text_runs?: string[] }>;
}): {
  added: number[];
  removed: number[];
  changed: Array<{
    slide_index: number;
    added_runs: string[];
    removed_runs: string[];
  }>;
  unchanged: number[];
} {
  const byIndexBefore = new Map(input.before.map((s) => [s.slide_index, s]));
  const byIndexAfter = new Map(input.after.map((s) => [s.slide_index, s]));

  const added: number[] = [];
  const removed: number[] = [];
  const changed: Array<{ slide_index: number; added_runs: string[]; removed_runs: string[] }> = [];
  const unchanged: number[] = [];

  const allIndices = new Set([...byIndexBefore.keys(), ...byIndexAfter.keys()]);
  for (const idx of Array.from(allIndices).sort((a, b) => a - b)) {
    const b = byIndexBefore.get(idx);
    const a = byIndexAfter.get(idx);
    if (!b && a) {
      added.push(idx);
      continue;
    }
    if (b && !a) {
      removed.push(idx);
      continue;
    }
    if (!b || !a) continue;

    const beforeRuns = new Set(b.text_runs || []);
    const afterRuns = new Set(a.text_runs || []);
    const addedRuns = [...afterRuns].filter((r) => !beforeRuns.has(r));
    const removedRuns = [...beforeRuns].filter((r) => !afterRuns.has(r));

    if (addedRuns.length === 0 && removedRuns.length === 0) {
      unchanged.push(idx);
    } else {
      changed.push({ slide_index: idx, added_runs: addedRuns, removed_runs: removedRuns });
    }
  }

  return { added, removed, changed, unchanged };
}

// ---------------------------------------------------------------------------
// LLM/voice-dependent ops — delegate to reasoning-backend / voice-bridge.
// Whether output is a real reasoning result or a deterministic placeholder
// depends on which backend is registered at runtime. The stub backends
// preserve end-to-end pipeline executability in offline environments.
// ---------------------------------------------------------------------------

export async function a2aFanout(input: {
  personas: string[];
  min_hypotheses_per_persona: number;
  topic: string;
  output_path: string;
}): Promise<{ written_to: string; reasoning_mode: 'placeholder' | 'model' }> {
  logger.warn(
    '[WISDOM_PERSONA_COMPAT] a2a_fanout uses unscoped persona labels; migrate to perspective_fanout with typed participants'
  );
  const backend = getReasoningBackend();
  const hypotheses = await backend.divergePersonas({
    topic: input.topic,
    personas: input.personas,
    minPerPersona: input.min_hypotheses_per_persona,
  });
  const reasoningMode = deriveReasoningMode(backend.name);
  writeJSON(input.output_path, {
    topic: input.topic,
    hypotheses,
    generated_by: backend.name,
    generated_at: nowIso(),
    reasoning_mode: reasoningMode,
  });
  return { written_to: input.output_path, reasoning_mode: reasoningMode };
}

interface PerspectiveFanoutReceipt {
  participant_id: string;
  backend_name: string;
  security_scope: ReasoningParticipant['security_scope'];
  effective_input_tier: 'personal' | 'confidential' | 'public';
  accepted_fragment_ids: string[];
  rejected_fragments: Array<{ fragment_id: string; code: string; reason: string }>;
}

export async function perspectiveFanout(input: {
  participants: ReasoningParticipant[];
  candidate_fragments?: GovernedContextFragment[];
  min_hypotheses_per_participant: number;
  topic: string;
  output_path: string;
  output_tier: 'personal' | 'confidential' | 'public';
}): Promise<{
  written_to: string;
  reasoning_mode: 'placeholder' | 'model';
  participant_count: number;
}> {
  if (!input.participants.length) {
    throw new Error('[PERSPECTIVE_FANOUT_INVALID] participants must not be empty');
  }
  const backend = getReasoningBackend();
  const hypotheses: any[] = [];
  const participantReceipts: PerspectiveFanoutReceipt[] = [];

  for (const participant of input.participants) {
    const resolvedParticipant = resolveReasoningParticipant({
      participant,
      candidate_fragments: input.candidate_fragments,
      backend_name: backend.name,
    });
    const outputGuard = validateContextOutputTier(
      resolvedParticipant.context_pack,
      input.output_tier
    );
    if (!outputGuard.allowed) throw new Error(outputGuard.reason);

    const participantHypotheses = await backend.divergePersonas({
      topic: input.topic,
      personas: [participant.participant_id],
      minPerPersona: input.min_hypotheses_per_participant,
      context: renderReasoningParticipantContext(resolvedParticipant),
    });
    hypotheses.push(
      ...participantHypotheses.map((hypothesis) => ({
        ...hypothesis,
        proposed_by: participant.participant_id,
        participant_id: participant.participant_id,
        perspective_ids: participant.perspective_ids,
      }))
    );
    participantReceipts.push({
      participant_id: participant.participant_id,
      backend_name: backend.name,
      security_scope: participant.security_scope,
      effective_input_tier: resolvedParticipant.context_pack.effective_input_tier,
      accepted_fragment_ids: resolvedParticipant.context_pack.fragments.map(
        (fragment) => fragment.fragment_id
      ),
      rejected_fragments: resolvedParticipant.context_pack.rejected.map((rejection) => ({
        fragment_id: rejection.fragment_id,
        code: rejection.code,
        reason: rejection.reason,
      })),
    });
  }

  const reasoningMode = deriveReasoningMode(backend.name);
  writeJSON(input.output_path, {
    operation: 'perspective_fanout',
    topic: input.topic,
    hypotheses,
    participant_receipts: participantReceipts,
    output_tier: input.output_tier,
    generated_by: backend.name,
    generated_at: nowIso(),
    reasoning_mode: reasoningMode,
  });
  return {
    written_to: input.output_path,
    reasoning_mode: reasoningMode,
    participant_count: input.participants.length,
  };
}

export async function typedCrossCritique(input: {
  source_path: string;
  participants: ReasoningParticipant[];
  output_path: string;
  output_tier: 'personal' | 'confidential' | 'public';
}): Promise<{ written_to: string; reasoning_mode: 'placeholder' | 'model' }> {
  const backend = getReasoningBackend();
  const src = readJSON<any>(input.source_path);
  if (src.operation !== 'perspective_fanout' || !Array.isArray(src.participant_receipts)) {
    throw new Error('[CROSS_CRITIQUE_SCOPE_MISSING] typed perspective fanout receipt is required');
  }
  const sourceTier = String(src.output_tier || '') as 'personal' | 'confidential' | 'public';
  const sourceScopes = new Map<string, ReasoningParticipant['security_scope']>(
    src.participant_receipts.map((receipt: PerspectiveFanoutReceipt) => [
      receipt.participant_id,
      receipt.security_scope,
    ])
  );

  for (const participant of input.participants) {
    const resolvedParticipant = resolveReasoningParticipant({
      participant,
      backend_name: backend.name,
    });
    if (!participant.security_scope.read_tiers.includes(sourceTier)) {
      throw new Error(
        `[CROSS_CRITIQUE_SCOPE_DENIED] ${participant.participant_id} cannot read ${sourceTier}`
      );
    }
    for (const sourceScope of sourceScopes.values()) {
      if (
        sourceTier !== 'public' &&
        (sourceScope.tenant_id !== participant.security_scope.tenant_id ||
          sourceScope.project_id !== participant.security_scope.project_id ||
          sourceScope.mission_id !== participant.security_scope.mission_id)
      ) {
        throw new Error(
          `[CROSS_CRITIQUE_SCOPE_DENIED] ${participant.participant_id} cannot receive cross-scope hypotheses`
        );
      }
    }
    const outputGuard = validateContextOutputTier(
      { effective_input_tier: sourceTier },
      input.output_tier
    );
    if (!outputGuard.allowed) throw new Error(outputGuard.reason);
  }

  const { hypotheses } = await backend.crossCritique({
    topic: src.topic,
    hypotheses: src.hypotheses ?? [],
    personas: input.participants.map((participant) => participant.participant_id),
  });
  const reasoningMode = deriveReasoningMode(backend.name);
  writeJSON(input.output_path, {
    operation: 'typed_cross_critique',
    topic: src.topic,
    hypotheses,
    participant_receipts: input.participants.map((participant) => ({
      participant_id: participant.participant_id,
      backend_name: backend.name,
      security_scope: participant.security_scope,
    })),
    output_tier: input.output_tier,
    generated_by: backend.name,
    generated_at: nowIso(),
    reasoning_mode: reasoningMode,
  });
  return { written_to: input.output_path, reasoning_mode: reasoningMode };
}

export async function crossCritique(input: {
  source_path: string;
  personas: string[];
  output_path: string;
}): Promise<{ written_to: string; reasoning_mode: 'placeholder' | 'model' }> {
  const backend = getReasoningBackend();
  const src = readJSON<any>(input.source_path);
  const { hypotheses } = await backend.crossCritique({
    topic: src.topic,
    hypotheses: src.hypotheses ?? [],
    personas: input.personas,
  });
  const reasoningMode = deriveReasoningMode(backend.name);
  writeJSON(input.output_path, {
    topic: src.topic,
    hypotheses,
    generated_by: backend.name,
    generated_at: nowIso(),
    reasoning_mode: reasoningMode,
  });
  return { written_to: input.output_path, reasoning_mode: reasoningMode };
}

export async function synthesizeCounterpartyPersona(input: {
  source_path: string;
  fidelity?: string;
}): Promise<{ persona_spec: any; reasoning_mode: 'placeholder' | 'model' }> {
  const backend = getReasoningBackend();
  const node = readJSON<any>(input.source_path);
  const fidelity = (input.fidelity as 'low' | 'medium' | 'high') || 'high';
  const persona = await backend.synthesizePersona({
    relationshipNode: node,
    fidelity,
  });
  const reasoningMode = deriveReasoningMode(backend.name);
  return {
    persona_spec: { ...persona, generated_by: backend.name, reasoning_mode: reasoningMode },
    reasoning_mode: reasoningMode,
  };
}

export async function a2aRoleplay(input: {
  persona: any;
  objective: string;
  time_budget_minutes: number;
  output_path: string;
}): Promise<{ written_to: string; reasoning_mode: 'placeholder' | 'model' }> {
  const bridge = getVoiceBridge();
  const result = await bridge.runRoleplaySession({
    objective: input.objective,
    timeBudgetMinutes: input.time_budget_minutes,
    personaSpec: input.persona ?? {},
    outputPath: input.output_path,
  });
  const reasoningMode = deriveReasoningMode(bridge.name, Boolean(result._synthetic));
  writeJSON(input.output_path, {
    objective: input.objective,
    time_budget_minutes: input.time_budget_minutes,
    persona_identity: input.persona?.identity ?? null,
    turns: result.turns,
    engine_id: result.engine_id ?? null,
    generated_by: bridge.name,
    generated_at: nowIso(),
    reasoning_mode: reasoningMode,
    ...(result._synthetic ? { _synthetic: true } : {}),
  });
  return { written_to: input.output_path, reasoning_mode: reasoningMode };
}

export function extractDissentSignals(input: { session_log_path: string; output_path: string }): {
  written_to: string;
} {
  const log = readJSON<any>(input.session_log_path);
  writeJSON(input.output_path, {
    person_slug: log.person_slug,
    visited_at: log.visited_at,
    stance: log.stance || 'neutral',
    conditions: log.conditions || [],
    dissent_signals: log.dissent_signals || [],
    extracted_at: nowIso(),
  });
  return { written_to: input.output_path };
}

export async function forkBranches(input: {
  source: string;
  execution_profile: string;
  cost_cap_tokens: number;
  max_steps_per_branch: number;
  output_dir: string;
}): Promise<{ written_to: string; branch_count: number; reasoning_mode: 'placeholder' | 'model' }> {
  const backend = getReasoningBackend();
  const src = readJSON<any>(input.source);
  const branches = await backend.forkBranches({
    hypotheses: src.hypotheses ?? [],
    executionProfile: input.execution_profile,
    costCapTokens: input.cost_cap_tokens,
    maxStepsPerBranch: input.max_steps_per_branch,
  });
  const reasoningMode = deriveReasoningMode(backend.name);
  const rebased = branches.map((b) => ({
    ...b,
    worktree_path: `${input.output_dir}/branch-${b.branch_id}/`,
  }));
  const manifest = {
    execution_profile: input.execution_profile,
    cost_cap_tokens: input.cost_cap_tokens,
    max_steps_per_branch: input.max_steps_per_branch,
    branches: rebased,
    generated_by: backend.name,
    generated_at: nowIso(),
    reasoning_mode: reasoningMode,
  };
  const manifestPath = `${input.output_dir.replace(/\/$/, '')}/branches.manifest.json`;
  writeJSON(manifestPath, manifest);
  return { written_to: manifestPath, branch_count: rebased.length, reasoning_mode: reasoningMode };
}

export async function simulateAll(input: {
  manifest_path?: string;
  goal: string;
  output_dir: string;
  max_steps_per_branch?: number;
}): Promise<{
  written_to: string;
  quality_written_to: string;
  quality_severity: 'ok' | 'warn' | 'poor';
  quality_retry_count: number;
  max_steps_per_branch: number;
  reasoning_mode: 'placeholder' | 'model';
}> {
  const backend = getReasoningBackend();
  const baseMaxSteps = Math.max(1, input.max_steps_per_branch ?? 10);
  const manifest =
    input.manifest_path && safeExistsSync(pathResolver.rootResolve(input.manifest_path))
      ? readJSON<any>(input.manifest_path)
      : { branches: [] };
  const outDir = input.output_dir.replace(/\/$/, '');
  const outPath = `${outDir}/simulation-summary.json`;
  const qualityPath = `${outDir}/simulation-quality.json`;

  const runSimulation = async (maxStepsPerBranch: number) => {
    const { branches: simulated } = await backend.simulateBranches({
      branches: manifest.branches ?? [],
      goal: input.goal,
      maxStepsPerBranch,
    });
    const reasoningMode = deriveReasoningMode(backend.name);
    const summary = {
      goal: input.goal,
      branches: simulated,
      generated_by: backend.name,
      timestamp: nowIso(),
      reasoning_mode: reasoningMode,
      max_steps_per_branch: maxStepsPerBranch,
    };
    const quality = evaluateSimulationQuality(summary);
    return { summary, quality, reasoningMode, maxStepsPerBranch };
  };

  let retryCount = 0;
  let finalRun = await runSimulation(baseMaxSteps);
  if (finalRun.quality.severity === 'poor') {
    retryCount = 1;
    const retrySteps = Math.max(baseMaxSteps + 2, Math.ceil(baseMaxSteps * 1.5));
    logger.info(
      `[simulateAll] quality severity poor; retrying with maxStepsPerBranch=${retrySteps}`
    );
    finalRun = await runSimulation(retrySteps);
  }
  // LC-06 (MO-07 residual): a still-poor result after the redo pass must not
  // dissolve into a persisted-but-unread severity — put it in front of the
  // operator.
  if (finalRun.quality.severity === 'poor') {
    sendOpsAlert({
      severity: 'warning',
      title: `Simulation quality stayed poor after redo: ${input.goal}`,
      context: {
        goal: input.goal,
        retry_count: retryCount,
        quality_path: qualityPath,
      },
      recommendation:
        'The branch simulation did not reach acceptable quality even after a wider redo pass. Review the hypotheses / goal framing before trusting this decision.',
      dedupe_key: `simulation-quality-poor:${input.goal}`,
    });
  }

  writeJSON(outPath, finalRun.summary);
  writeJSON(qualityPath, finalRun.quality);

  return {
    written_to: outPath,
    quality_written_to: qualityPath,
    quality_severity: finalRun.quality.severity,
    quality_retry_count: retryCount,
    max_steps_per_branch: finalRun.maxStepsPerBranch,
    reasoning_mode: finalRun.reasoningMode,
  };
}

// ---------------------------------------------------------------------------
/**
 * Run `simulate_all` N times against the same manifest and aggregate the
 * outcomes into an ensemble report. Addresses IP-3 (Counterfactual ensemble
 * layer): one shot is non-deterministic; N shots let the operator see the
 * distribution of outcomes and reason about it.
 *
 * Each individual run is persisted alongside the ensemble summary so the
 * trail is auditable. The ensemble file also carries the convergence
 * report from `evaluateEnsembleConvergence` (IP-4).
 */
export async function simulateAllEnsemble(input: {
  manifest_path?: string;
  goal: string;
  output_dir: string;
  runs: number;
  convergence_threshold?: number;
}): Promise<{
  ensemble_written_to: string;
  individual_runs_dir: string;
  convergence_severity: 'ok' | 'warn' | 'poor';
  divergent_outcomes_warning: boolean;
  retry_count: number;
}> {
  if (!Number.isInteger(input.runs) || input.runs < 2) {
    throw new Error('[simulateAllEnsemble] runs must be an integer >= 2');
  }
  const outDir = input.output_dir.replace(/\/$/, '');
  const runsDir = `${outDir}/ensemble-runs`;
  safeMkdir(pathResolver.rootResolve(runsDir), { recursive: true });

  const executeEnsemble = async (runsCount: number) => {
    const runs: any[] = [];
    for (let i = 0; i < runsCount; i++) {
      const runOutDir = `${runsDir}/run-${i + 1}`;
      safeMkdir(pathResolver.rootResolve(runOutDir), { recursive: true });
      const result = await simulateAll({
        ...(input.manifest_path ? { manifest_path: input.manifest_path } : {}),
        goal: input.goal,
        output_dir: runOutDir,
      });
      const summaryPath = result.written_to;
      runs.push({
        run_index: i + 1,
        summary_path: summaryPath,
        quality_severity: result.quality_severity,
        summary: readJSON<any>(summaryPath),
      });
    }
    const convergence = evaluateEnsembleConvergence({
      runs: runs.map((r) => r.summary),
      threshold: input.convergence_threshold ?? 0.6,
    });
    return { runs, convergence };
  };

  let retryCount = 0;
  let ensembleRun = await executeEnsemble(input.runs);
  if (ensembleRun.convergence.severity === 'poor') {
    retryCount = 1;
    const retryRuns = Math.max(input.runs + 2, Math.ceil(input.runs * 1.5));
    logger.info(`[simulateAllEnsemble] convergence poor; retrying with runs=${retryRuns}`);
    ensembleRun = await executeEnsemble(retryRuns);
  }
  // LC-06 (MO-07 residual): escalate a still-poor convergence after redo.
  if (ensembleRun.convergence.severity === 'poor') {
    sendOpsAlert({
      severity: 'warning',
      title: `Simulation ensemble stayed divergent after redo: ${input.goal}`,
      context: {
        goal: input.goal,
        retry_count: retryCount,
        runs: ensembleRun.runs.length,
      },
      recommendation:
        'Ensemble runs did not converge even after adding runs. The decision space is unstable — narrow the hypotheses or escalate to a human decision.',
      dedupe_key: `simulation-convergence-poor:${input.goal}`,
    });
  }

  const runs = ensembleRun.runs;
  const convergence = ensembleRun.convergence;

  const ensemble = {
    goal: input.goal,
    runs: runs.length,
    individual: runs.map((r) => ({
      run_index: r.run_index,
      summary_path: r.summary_path,
      quality_severity: r.quality_severity,
    })),
    convergence,
    timestamp: nowIso(),
    retry_count: retryCount,
  };
  const ensemblePath = `${outDir}/simulation-ensemble.json`;
  writeJSON(ensemblePath, ensemble);

  return {
    ensemble_written_to: ensemblePath,
    individual_runs_dir: runsDir,
    convergence_severity: convergence.severity,
    divergent_outcomes_warning: convergence.divergent_outcomes_warning,
    retry_count: retryCount,
  };
}

/**
 * Compute outcome convergence across an ensemble of `simulation-summary.json`
 * shapes (IP-4 — Uncertainty Quantification).
 *
 * For each branch_id present in the union of runs, count how often it
 * resolved to the same outcome category (`failure` / `success` / `pending`).
 * Convergence score for that branch = max-count / total-runs (1.0 = full
 * agreement). The ensemble convergence is the mean of per-branch scores.
 *
 * The rubric also raises `divergent_outcomes_warning` if mean < threshold,
 * letting the operator-facing layer surface the uncertainty as
 * "this analysis did not converge across reruns" rather than presenting
 * a single non-deterministic answer.
 */
export interface EnsembleConvergenceReport {
  severity: 'ok' | 'warn' | 'poor';
  mean_convergence: number;
  threshold: number;
  divergent_outcomes_warning: boolean;
  per_branch: Array<{
    branch_id: string;
    runs_seen: number;
    outcome_counts: { failure: number; success: number; pending: number };
    dominant_outcome: 'failure' | 'success' | 'pending' | 'tie';
    convergence: number;
  }>;
  generated_at: string;
}

export function evaluateEnsembleConvergence(input: {
  runs: Array<{
    branches?: Array<{
      branch_id: string;
      first_failure_mode: string | null;
      first_success_mode: string | null;
    }>;
  }>;
  threshold?: number;
}): EnsembleConvergenceReport {
  const threshold = input.threshold ?? 0.6;
  const runs = input.runs ?? [];
  // For each branch_id, how many times did each outcome category appear?
  const buckets = new Map<string, { failure: number; success: number; pending: number }>();
  for (const run of runs) {
    for (const b of run.branches ?? []) {
      const bucket = buckets.get(b.branch_id) ?? { failure: 0, success: 0, pending: 0 };
      if (b.first_failure_mode) bucket.failure += 1;
      else if (b.first_success_mode) bucket.success += 1;
      else bucket.pending += 1;
      buckets.set(b.branch_id, bucket);
    }
  }
  const total = runs.length || 1;
  const perBranch: EnsembleConvergenceReport['per_branch'] = [];
  for (const [branchId, counts] of buckets) {
    const seen = counts.failure + counts.success + counts.pending;
    const max = Math.max(counts.failure, counts.success, counts.pending);
    let dominant: 'failure' | 'success' | 'pending' | 'tie' = 'tie';
    const ties = ['failure', 'success', 'pending'].filter((k) => (counts as any)[k] === max);
    if (ties.length === 1) dominant = ties[0] as any;
    perBranch.push({
      branch_id: branchId,
      runs_seen: seen,
      outcome_counts: { ...counts },
      dominant_outcome: dominant,
      convergence: total > 0 ? max / total : 0,
    });
  }
  const meanConvergence =
    perBranch.length === 0
      ? 1
      : perBranch.reduce((acc, b) => acc + b.convergence, 0) / perBranch.length;
  const divergentWarning = meanConvergence < threshold;
  const severity: 'ok' | 'warn' | 'poor' =
    perBranch.length === 0
      ? 'poor'
      : meanConvergence >= threshold
        ? 'ok'
        : meanConvergence >= threshold / 2
          ? 'warn'
          : 'poor';
  return {
    severity,
    mean_convergence: Number(meanConvergence.toFixed(4)),
    threshold,
    divergent_outcomes_warning: divergentWarning,
    per_branch: perBranch.sort((a, b) => a.branch_id.localeCompare(b.branch_id)),
    generated_at: nowIso(),
  };
}

/**
 * Sanity / quality rubric for a counterfactual `simulation-summary.json`.
 *
 * Applies six deterministic checks on top of the LLM-produced output to
 * surface non-determinism, persona imbalance, or vacuous results — none of
 * which the underlying reasoning model can be relied on to self-detect.
 *
 * Severity levels:
 *   - `ok`    : every check passes
 *   - `warn`  : at least one soft check failed (worth review, not blocking)
 *   - `poor`  : at least one hard check failed (treat the simulation as
 *               unreliable; re-run with a stronger model or smaller scope)
 */
export interface SimulationQualityReport {
  severity: 'ok' | 'warn' | 'poor';
  branch_count: number;
  checks: Array<{
    id: string;
    severity: 'soft' | 'hard';
    passed: boolean;
    detail: string;
  }>;
  generated_at: string;
}

export function evaluateSimulationQuality(summary: {
  goal: string;
  branches: Array<{
    branch_id: string;
    hypothesis_ref: string;
    first_failure_mode: string | null;
    first_success_mode: string | null;
    terminated_at_step: number | null;
  }>;
}): SimulationQualityReport {
  const branches = summary.branches ?? [];
  const checks: SimulationQualityReport['checks'] = [];

  // Hard 1 — there must be at least one branch.
  checks.push({
    id: 'has_branches',
    severity: 'hard',
    passed: branches.length > 0,
    detail:
      branches.length > 0
        ? `${branches.length} branches simulated`
        : 'simulation produced zero branches',
  });

  // Hard 2 — no branch may report both a failure and a success mode (logical XOR).
  const xorViolators = branches.filter((b) => b.first_failure_mode && b.first_success_mode);
  checks.push({
    id: 'failure_xor_success',
    severity: 'hard',
    passed: xorViolators.length === 0,
    detail:
      xorViolators.length === 0
        ? 'every branch has at most one terminal mode'
        : `${xorViolators.length} branches report both failure and success modes (${xorViolators.map((b) => b.branch_id).join(', ')})`,
  });

  // Hard 3 — branch_id values must be unique.
  const ids = branches.map((b) => b.branch_id);
  const dupCount = ids.length - new Set(ids).size;
  checks.push({
    id: 'unique_branch_ids',
    severity: 'hard',
    passed: dupCount === 0,
    detail:
      dupCount === 0 ? 'branch ids are unique' : `${dupCount} duplicate branch_id values detected`,
  });

  // Soft 4 — at least one branch must reach a terminal mode (otherwise the
  // simulation produced no usable signal).
  const terminated = branches.filter((b) => b.first_failure_mode || b.first_success_mode);
  checks.push({
    id: 'reaches_terminal_mode',
    severity: 'soft',
    passed: terminated.length > 0,
    detail:
      terminated.length > 0
        ? `${terminated.length}/${branches.length} branches reached a terminal mode`
        : 'no branch reached a terminal mode — simulation is vacuous',
  });

  // Soft 5 — outcome balance: if N>=3 branches and all terminated as
  // failures (or all successes), the simulation may be biased.
  let outcomeBalanced = true;
  let outcomeDetail = 'fewer than 3 terminated branches — balance not assessed';
  if (terminated.length >= 3) {
    const failures = terminated.filter((b) => b.first_failure_mode).length;
    const successes = terminated.filter((b) => b.first_success_mode).length;
    if (failures === terminated.length || successes === terminated.length) {
      outcomeBalanced = false;
      outcomeDetail = `all ${terminated.length} terminated branches share the same outcome (${failures === terminated.length ? 'failure' : 'success'})`;
    } else {
      outcomeDetail = `outcomes split ${failures} fail / ${successes} success`;
    }
  }
  checks.push({
    id: 'outcome_balance',
    severity: 'soft',
    passed: outcomeBalanced,
    detail: outcomeDetail,
  });

  // Soft 6 — termination depth: every terminated branch should report a
  // non-zero `terminated_at_step` (zero usually means the model gave up
  // immediately rather than simulating).
  const zeroDepth = terminated.filter(
    (b) => b.terminated_at_step !== null && b.terminated_at_step <= 0
  );
  checks.push({
    id: 'non_trivial_termination_depth',
    severity: 'soft',
    passed: zeroDepth.length === 0,
    detail:
      zeroDepth.length === 0
        ? 'all terminated branches reached at least one step'
        : `${zeroDepth.length} branches terminated at step <= 0 (likely vacuous)`,
  });

  const hardFailed = checks.some((c) => c.severity === 'hard' && !c.passed);
  const softFailed = checks.some((c) => c.severity === 'soft' && !c.passed);
  const severity: 'ok' | 'warn' | 'poor' = hardFailed ? 'poor' : softFailed ? 'warn' : 'ok';

  return {
    severity,
    branch_count: branches.length,
    checks,
    generated_at: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher — routes wisdom: decision ops from the pipeline engine.
// Returns ctx augmented with op output if export_as is provided.
// ---------------------------------------------------------------------------

/**
 * Ops that consume reasoning-backend budget. Listed here so the
 * dispatcher can apply per-tenant rate limiting before delegating.
 */
const RATE_LIMITED_OPS = new Set([
  'a2a_fanout',
  'cross_critique',
  'synthesize_counterparty_persona',
  'a2a_roleplay',
  'fork_branches',
  'simulate_all',
  'simulate_all_ensemble',
  'extract_requirements',
  'extract_design_spec',
  'extract_test_plan',
  'decompose_into_tasks',
  'peer_advice',
  'reasoning',
  'tool_use',
  'react_loop',
]);

export async function dispatchDecisionOp(
  op: string,
  params: any,
  ctx: Ctx,
  options: { compatibilityMode?: boolean } = {}
): Promise<{ handled: boolean; ctx: Ctx }> {
  const resolved = (k: string) => resolveVars(params[k], ctx);
  const exportAs = params.export_as;
  const forwardedContext = await forwardWisdomBoundaryOperation(op, params, ctx, {
    compatibilityMode: options.compatibilityMode,
    defaultExportKey: `last_${op}_result`,
  });
  if (forwardedContext) return { handled: true, ctx: forwardedContext as Ctx };
  /**
   * Behavior: if `export_as` is set, the entire result lands at
   * `ctx[exportAs]`. Otherwise — if the result is a plain object —
   * its keys are merged into `ctx` so subsequent steps can reference
   * `{{key}}` directly. This was previously a silent-drop, which made
   * pipeline templating surprising; the merge is strictly additive.
   */
  const assign = (value: any): Ctx => {
    if (exportAs) {
      return assignWisdomContextValue(ctx, String(exportAs), value, options);
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return mergeWisdomContext(ctx, value as Record<string, unknown>, options);
    }
    return ctx;
  };

  // Per-tenant rate limit gate (IP-29 / tenant-rate-limit-policy.json).
  // If the active execution is bound to a tenant and the op is in the
  // rate-limited set, deduct the cost from the tenant's bucket. On denial
  // raise so the pipeline runner records the failure (rather than silently
  // skipping the op).
  if (RATE_LIMITED_OPS.has(op)) {
    const decision = consumeTenantBudget({ op: `wisdom:${op}` });
    if (!decision.allowed) {
      throw new TenantRateLimitExceededError(decision, '');
    }
  }

  switch (op) {
    case 'stakeholder_grid_sort': {
      const nodes = Array.isArray(params.nodes)
        ? params.nodes
        : ctx[params.from || 'stakeholder_nodes'] || [];
      const sorted = stakeholderGridSort(nodes);
      return { handled: true, ctx: assign(sorted) };
    }

    case 'find_slides_by_owner': {
      const slides = Array.isArray(params.slides)
        ? params.slides
        : ctx[params.slides_from || 'slides'] || ctx['last_pptx_slides'] || [];
      const ownerLabels: string[] =
        params.owner_labels ||
        (params.owner_label ? [params.owner_label] : []) ||
        ctx[params.owner_labels_from || 'owner_labels'] ||
        [];
      const result = findSlidesByOwner({
        slides,
        owner_labels: ownerLabels,
        match_mode: params.match_mode,
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'pptx_diff': {
      const before = Array.isArray(params.before)
        ? params.before
        : ctx[params.before_from || 'before_slides'] || [];
      const after = Array.isArray(params.after)
        ? params.after
        : ctx[params.after_from || 'after_slides'] || [];
      const result = pptxDiff({ before, after });
      return { handled: true, ctx: assign(result) };
    }

    case 'emit_dissent_log': {
      const result = emitDissentLog({
        source_path: resolved('source') || resolved('source_path'),
        output_path: resolved('output_path') || resolved('append_to'),
        append: Boolean(params.append_to),
        mission_id: resolved('mission_id'),
        topic: resolved('topic'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'render_hypothesis_report': {
      const result = renderHypothesisReport({
        source_path: resolved('source') || resolved('source_path'),
        output_path: resolved('output_path'),
        title: resolved('title'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'curate_background_review': {
      const maxAgeDays = Number(resolved('max_age_days'));
      const rawDryRun = resolved('dry_run');
      const result = curateBackgroundReviewProposals({
        maxAgeMs:
          Number.isFinite(maxAgeDays) && maxAgeDays >= 0
            ? maxAgeDays * 24 * 60 * 60 * 1000
            : undefined,
        limit: Number(resolved('limit')) || undefined,
        dryRun: rawDryRun === true || String(rawDryRun).toLowerCase() === 'true',
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'distill': {
      // Memory distillation (intent-loop ⑤→⑥): summarize recently distilled
      // knowledge into operational lessons. Used by
      // pipelines/fragments/memory-distillation.json, whose sink writes the
      // result (channel "lessons_learned") into HINTS.md. Previously this op had
      // no handler and the pipeline silently produced nothing.
      const scope = resolved('scope') || 'recent_missions';
      const limit = Number(resolved('limit')) || 20;
      // Source the most recent distilled-knowledge candidates directly (newest
      // first). Topic-relevance search is the wrong tool for a "recent" scope —
      // it needs a query and returns nothing for the empty topic this op uses.
      const seenLesson = new Set<string>();
      const records = listDistillCandidateRecords()
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .filter((r) => {
          const key = `${r.title || ''}|${r.summary || ''}`;
          if (seenLesson.has(key)) return false;
          seenLesson.add(key);
          return true;
        })
        .slice(0, limit);
      const body =
        records.length === 0
          ? '_(no distilled lessons available yet — run missions and `mission_controller distill` to populate)_'
          : records
              .map(
                (r) =>
                  `- **${r.title || r.candidate_id}** (${r.target_kind || 'lesson'}, ${r.status}) — ${r.summary || ''}`
              )
              .join('\n');
      const markdown = `_Distilled from ${records.length} recent lesson(s) (scope: ${scope}), generated ${nowIso()}._\n\n${body}`;
      // run_pipeline bridges produces.channel → params.export_as, so `assign`
      // lands this markdown at the declared channel (e.g. "lessons_learned").
      return { handled: true, ctx: assign(markdown) };
    }

    case 'inject_prior_knowledge': {
      const topic = resolved('topic') || '';
      const tagsParam = resolved('tags');
      const tags = Array.isArray(tagsParam) ? tagsParam : [];
      const limit = Number(resolved('limit')) || 5;
      const minScore = params.min_score !== undefined ? Number(resolved('min_score')) : 0.0001;
      const entries = await findRelevantDistilledKnowledge({
        topic,
        tags,
        limit,
        minScore,
      });
      const summary =
        entries.length === 0
          ? '(no relevant prior distilled knowledge found)'
          : entries.map((e) => formatDistilledKnowledgeSummary(e)).join('\n');
      const outputPath = resolved('output_path');
      if (outputPath) {
        writeJSON(outputPath, {
          topic,
          tags,
          limit,
          entries,
          summary,
          generated_at: nowIso(),
        });
      }
      return {
        handled: true,
        ctx: assign({
          prior_knowledge_entries: entries,
          prior_knowledge_summary: summary,
          prior_knowledge_count: entries.length,
          ...(outputPath ? { written_to: outputPath } : {}),
        }),
      };
    }

    case 'evaluate_simulation_quality': {
      const sourcePath = resolved('source') || resolved('source_path');
      const outputPath = resolved('output_path');
      const summary = readJSON<any>(sourcePath);
      const report = evaluateSimulationQuality(summary);
      writeJSON(outputPath, report);
      return { handled: true, ctx: assign({ written_to: outputPath, severity: report.severity }) };
    }

    case 'simulate_all_ensemble': {
      const result = await simulateAllEnsemble({
        ...(resolved('manifest_path') ? { manifest_path: resolved('manifest_path') } : {}),
        goal: resolved('goal'),
        output_dir: resolved('output_dir'),
        runs: Number(resolved('runs')) || Number(params.runs) || 3,
        ...(params.convergence_threshold !== undefined
          ? { convergence_threshold: Number(resolved('convergence_threshold')) }
          : {}),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'evaluate_ensemble_convergence': {
      const sourcePaths: string[] = Array.isArray(params.sources)
        ? params.sources.map((p: string) => resolveVars(p, ctx))
        : [];
      const runs = sourcePaths.map((p) => readJSON<any>(p));
      const threshold = params.threshold !== undefined ? Number(resolved('threshold')) : undefined;
      const report = evaluateEnsembleConvergence({
        runs,
        ...(threshold !== undefined ? { threshold } : {}),
      });
      const outputPath = resolved('output_path');
      if (outputPath) writeJSON(outputPath, report);
      return {
        handled: true,
        ctx: assign({
          ...(outputPath ? { written_to: outputPath } : {}),
          severity: report.severity,
          mean_convergence: report.mean_convergence,
          divergent_outcomes_warning: report.divergent_outcomes_warning,
        }),
      };
    }

    case 'compute_readiness_matrix': {
      const result = computeReadinessMatrix({
        visits_dir: resolved('visits_dir'),
        proposal_ref: resolved('proposal_ref'),
        deadline: resolved('deadline'),
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'recommend': {
      const result = recommend({
        readiness_ref: resolved('readiness_ref'),
        options: params.options,
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'resolve_hypothesis_conflict': {
      const result = resolveHypothesisConflict({
        source_path: resolved('source_path'),
        tenant_slug: params.tenant_slug ? resolved('tenant_slug') : null,
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'adjust_proposal': {
      const result = adjustProposalAppend({
        proposal_path: resolved('proposal') || resolved('proposal_path'),
        signals: params.new_signals || ctx[params.signals_from || 'new_signals'],
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'a2a_fanout': {
      const personasResolved =
        resolved('personas') || ctx[params.personas_from || 'personas'] || [];
      const minResolved = resolved('min_hypotheses_per_persona') || 2;
      const result = await a2aFanout({
        personas: Array.isArray(personasResolved) ? personasResolved : [],
        min_hypotheses_per_persona: Number(minResolved) || 2,
        topic: resolved('topic'),
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'perspective_fanout': {
      const participantsResolved =
        resolved('participants') || ctx[params.participants_from || 'participants'] || [];
      const fragmentsResolved =
        resolved('context_fragments') ||
        ctx[params.context_fragments_from || 'context_fragments'] ||
        [];
      const result = await perspectiveFanout({
        participants: Array.isArray(participantsResolved) ? participantsResolved : [],
        candidate_fragments: Array.isArray(fragmentsResolved) ? fragmentsResolved : [],
        min_hypotheses_per_participant: Number(resolved('min_hypotheses_per_participant')) || 2,
        topic: resolved('topic'),
        output_path: resolved('output_path'),
        output_tier: resolved('output_tier') || 'public',
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'cross_critique': {
      const personasResolved =
        resolved('personas') || ctx[params.personas_from || 'personas'] || [];
      const result = await crossCritique({
        source_path: resolved('input') || resolved('source_path'),
        personas: Array.isArray(personasResolved) ? personasResolved : [],
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'typed_cross_critique': {
      const participantsResolved =
        resolved('participants') || ctx[params.participants_from || 'participants'] || [];
      const result = await typedCrossCritique({
        source_path: resolved('input') || resolved('source_path'),
        participants: Array.isArray(participantsResolved) ? participantsResolved : [],
        output_path: resolved('output_path'),
        output_tier: resolved('output_tier') || 'public',
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'synthesize_counterparty_persona': {
      const result = await synthesizeCounterpartyPersona({
        source_path: resolved('source'),
        fidelity: resolved('fidelity'),
      });
      return { handled: true, ctx: assign(result.persona_spec) };
    }

    case 'a2a_roleplay':
    case 'counterparty_roleplay': {
      const result = await a2aRoleplay({
        persona: params.persona || ctx[params.persona_from || 'persona_spec'],
        objective: resolved('objective'),
        time_budget_minutes: params.time_budget_minutes || 15,
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'extract_dissent_signals': {
      const result = extractDissentSignals({
        session_log_path: resolved('session_log') || resolved('session_log_path'),
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'fork_branches': {
      const result = await forkBranches({
        source: resolved('source'),
        execution_profile: resolved('execution_profile') || 'counterfactual',
        cost_cap_tokens: params.cost_cap_tokens || 20000,
        max_steps_per_branch: params.max_steps_per_branch || 10,
        output_dir: resolved('output_dir') || 'active/shared/tmp/counterfactual/',
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'simulate_all': {
      const result = await simulateAll({
        manifest_path: resolved('manifest_path'),
        goal: resolved('goal'),
        output_dir: resolved('output_dir'),
        max_steps_per_branch: params.max_steps_per_branch || 10,
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'capture_intuition': {
      const result = captureIntuition({
        decision: resolved('decision'),
        anchor: resolved('anchor'),
        analogy: resolved('analogy'),
        vetoed_options:
          params.vetoed_options || ctx[params.vetoed_options_from || 'vetoed_options'],
        mission_id: resolved('mission_id'),
        trigger: resolved('trigger') as CaptureIntuitionInput['trigger'],
        tags: params.tags || ctx[params.tags_from || 'tags'],
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'register_presentation_preference_profile': {
      const result = await registerPresentationPreferenceProfileOp({
        profile:
          params.profile !== undefined
            ? resolved('profile')
            : ctx[params.profile_from || 'presentation_preference_profile'],
        profile_path: resolved('profile_path'),
        registry_path: resolved('registry_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'transcribe_audio': {
      const bridge = getSpeechToTextBridge();
      const result = await bridge.transcribe({
        audioPath: resolved('audio_path'),
        language: resolved('language'),
        outputPath: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    // ── Adaptive Prompting: wisdom:reasoning ─────────────────────────────
    // Routes through the active reasoning backend. Fixes the previous no-op
    // where wisdom:reasoning fell through to default with handled=false.
    case 'reasoning': {
      const instruction =
        typeof params.instruction === 'string'
          ? resolveVars(params.instruction, ctx)
          : 'Analyze the context.';
      const contextRaw =
        typeof params.context === 'string'
          ? resolveVars(params.context, ctx)
          : JSON.stringify(params.context ?? ctx);
      // Adaptive Prompting: optional system_prompt param overrides default framing
      const systemPrompt =
        typeof params.system_prompt === 'string'
          ? resolveVars(params.system_prompt, ctx)
          : undefined;
      const allowBackendDelegation =
        params.use_subagent === true ||
        String(params.execution_mode ?? params.mode ?? '') === 'subagent' ||
        String(params.execution_mode ?? params.mode ?? '') === 'delegate';
      const response = await runPureReasoning({
        instruction,
        context: contextRaw,
        systemPrompt,
        allowBackendDelegation,
      });
      return { handled: true, ctx: assign(response) };
    }

    case 'peer_advice': {
      const question =
        typeof params.question === 'string'
          ? resolveVars(params.question, ctx)
          : typeof params.instruction === 'string'
            ? resolveVars(params.instruction, ctx)
            : '';
      const contextRaw =
        typeof params.context === 'string'
          ? resolveVars(params.context, ctx)
          : JSON.stringify(params.context ?? ctx);
      const result = await runPeerAdvice({
        question,
        context: contextRaw,
        tone: params.tone === 'concise' || params.tone === 'adversarial' ? params.tone : 'careful',
        preferredProvider:
          typeof params.preferred_provider === 'string'
            ? resolveVars(params.preferred_provider, ctx)
            : undefined,
        preferredLabel:
          typeof params.preferred_label === 'string'
            ? resolveVars(params.preferred_label, ctx)
            : undefined,
        modelTier: params.model_tier,
        contextLabel: String(params.context_label || 'wisdom:peer_advice'),
      });
      const outputPath = resolved('output_path');
      if (outputPath) writeJSON(outputPath, result);
      return { handled: true, ctx: assign(result) };
    }

    // ── Mixture of Experts: wisdom:tool_use ──────────────────────────────
    // Invokes the reasoning backend's Function Calling interface.
    // Tools are defined inline in the pipeline step params.
    case 'tool_use':
    case 'propose_tool_calls': {
      const prompt = resolveVars(String(params.prompt ?? params.instruction ?? ''), ctx);
      const tools = Array.isArray(params.tools) ? params.tools : [];
      const result = await proposeToolCalls({ prompt, tools });
      return {
        handled: true,
        ctx:
          op === 'propose_tool_calls'
            ? assign(result)
            : assign({ text: result.text, toolCalls: result.toolCalls }),
      };
    }

    // ── ReAct: wisdom:react_loop ──────────────────────────────────────────
    // Thought → Action → Observation loop with configurable max_steps.
    // Emits { goal, steps: [{role,content}], final_answer }.
    case 'react_loop':
    case 'reasoning_loop': {
      const goal = resolveVars(String(params.goal ?? params.instruction ?? ''), ctx);
      const maxSteps = Number(params.max_steps ?? 5);
      const tools = Array.isArray(params.tools) ? params.tools : [];
      const reactResult = await runReasoningLoop({ goal, maxSteps, tools });
      return { handled: true, ctx: assign(reactResult) };
    }

    // ── Uncertainty Quantification → Gate: wisdom:uncertainty_gate ───────
    // Reads ensemble convergence score and emits a gate verdict:
    //   mean_convergence >= threshold → ready
    //   mean_convergence >= yellow_threshold → concerns (YELLOW-CARD)
    //   mean_convergence <  yellow_threshold → blocked
    case 'uncertainty_gate': {
      const convergenceKey = String(params.from ?? 'mean_convergence');
      const severityKey = String(params.severity_from ?? 'convergence_severity');
      const rawScore = ctx[convergenceKey] ?? params.mean_convergence;
      const rawSeverity = ctx[severityKey] ?? params.convergence_severity;
      const score = typeof rawScore === 'number' ? rawScore : parseFloat(String(rawScore ?? '1'));
      const threshold = typeof params.threshold === 'number' ? params.threshold : 0.7;
      const yellowThreshold =
        typeof params.yellow_threshold === 'number' ? params.yellow_threshold : 0.5;

      let verdict: 'ready' | 'concerns' | 'blocked';
      if (!isNaN(score)) {
        if (score >= threshold) verdict = 'ready';
        else if (score >= yellowThreshold) verdict = 'concerns';
        else verdict = 'blocked';
      } else {
        // Fall back to severity string when score unavailable
        const sev = String(rawSeverity ?? 'ok');
        verdict = sev === 'ok' ? 'ready' : sev === 'warn' ? 'concerns' : 'blocked';
      }

      const gateResult = {
        verdict,
        mean_convergence: isNaN(score) ? null : score,
        convergence_severity: rawSeverity ?? null,
        threshold,
        yellow_threshold: yellowThreshold,
        timestamp: nowIso(),
      };

      const outputPath = resolved('output_path');
      if (outputPath) writeJSON(outputPath, gateResult);

      if (verdict === 'blocked') {
        logger.warn(
          `[uncertainty_gate] BLOCKED: mean_convergence=${score.toFixed?.(3) ?? score} < yellow_threshold=${yellowThreshold}`
        );
      } else if (verdict === 'concerns') {
        logger.warn(
          `[uncertainty_gate] YELLOW-CARD: mean_convergence=${score.toFixed?.(3) ?? score} < threshold=${threshold}`
        );
      } else {
        logger.success(
          `[uncertainty_gate] READY: mean_convergence=${score.toFixed?.(3) ?? score} ≥ threshold=${threshold}`
        );
      }

      return { handled: true, ctx: assign(gateResult) };
    }

    default:
      return { handled: false, ctx };
  }
}
