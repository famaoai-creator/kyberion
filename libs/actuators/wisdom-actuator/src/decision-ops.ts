import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  pathResolver,
  resolveVars,
  getReasoningBackend,
  getVoiceBridge,
  getSpeechToTextBridge,
  saveRequirementsDraft,
  evaluateRequirementsCompletenessGate,
  evaluateCustomerSignoffGate,
  saveDesignSpec,
  saveTestPlan,
  saveTaskPlan,
  readRequirementsDraft,
  readDesignSpec,
  readTestPlan,
  readTaskPlan,
  evaluateArchitectureReadyGate,
  evaluateQaReadyGate,
  evaluateTaskPlanReadyGate,
  consumeTenantBudget,
  TenantRateLimitExceededError,
  findRelevantDistilledKnowledge,
  formatDistilledKnowledgeSummary,
  recordActionItem,
  listActionItems,
  listOthersPending,
  listOperatorSelfPending,
  appendReminder,
  updateActionItemStatus,
  nextActionItemId,
  matchRestrictedAction,
  loadMeetingFacilitatorPolicy,
  type ActionItem,
  type ActionItemAssignee,
  type ActionItemAssigneeKind,
  type ActionItemModality,
  type ActionItemReviewState,
  type ActionItemProvenance,
  type MeetingFacilitatorPolicy,
} from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import * as path from 'node:path';

/**
 * Decision-support operations for Kyberion.
 *
 * Implements the runtime for the protocols in:
 *   knowledge/public/orchestration/{hypothesis-tree,counterfactual-simulation,
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

function generateHeuristicId(): string {
  // Short ULID-ish id: time-ordered, url-safe.
  const time = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `HEU-${time}-${rand}`;
}

// ---------------------------------------------------------------------------
// Extract Requirements — drives the customer_engagement mission. Reads a
// transcript / notes file, calls the registered reasoning backend to produce
// an ExtractedRequirements object, and persists it as the mission's
// requirements-draft.json via the store. Gate evaluators live on the store.
// ---------------------------------------------------------------------------

export interface ExtractRequirementsOpInput {
  mission_id: string;
  project_name: string;
  source_path: string;
  source_type?: 'call_recording' | 'call_transcript' | 'meeting_notes' | 'document_pack' | 'chat_log' | 'mixed';
  language?: string;
  customer_name?: string;
  customer_person_slug?: string;
  customer_org?: string;
  prior_draft_ref?: string;
}

export async function extractRequirementsOp(
  input: ExtractRequirementsOpInput,
): Promise<{ mission_id: string; version: string; draft_path: string; completeness: { passed: boolean; reasons: string[] } }> {
  if (!input.mission_id || !input.project_name || !input.source_path) {
    throw new Error(
      '[extract_requirements] requires mission_id, project_name, and source_path',
    );
  }
  const backend = getReasoningBackend();
  const sourceAbs = pathResolver.rootResolve(input.source_path);
  if (!safeExistsSync(sourceAbs)) {
    throw new Error(`[extract_requirements] source not found: ${input.source_path}`);
  }
  const sourceText = safeReadFile(sourceAbs, { encoding: 'utf8' }) as string;

  let priorDraft: unknown;
  if (input.prior_draft_ref) {
    const priorAbs = pathResolver.rootResolve(input.prior_draft_ref);
    if (safeExistsSync(priorAbs)) {
      priorDraft = JSON.parse(safeReadFile(priorAbs, { encoding: 'utf8' }) as string);
    }
  }

  const customer =
    input.customer_name || input.customer_person_slug || input.customer_org
      ? {
          ...(input.customer_name ? { name: input.customer_name } : {}),
          ...(input.customer_person_slug ? { person_slug: input.customer_person_slug } : {}),
          ...(input.customer_org ? { org: input.customer_org } : {}),
        }
      : undefined;

  const extracted = await backend.extractRequirements({
    sourceText,
    projectName: input.project_name,
    customer,
    language: input.language,
    priorDraft,
  });

  const draft = saveRequirementsDraft({
    missionId: input.mission_id,
    projectName: input.project_name,
    extracted,
    customer,
    elicitationSource: {
      type: input.source_type ?? 'meeting_notes',
      refs: [input.source_path],
      ...(input.language ? { language: input.language } : {}),
    },
    generatedBy: backend.name,
  });

  const completeness = evaluateRequirementsCompletenessGate(input.mission_id);

  const draftPath = `active/missions/${input.mission_id}/evidence/requirements-draft.json`;
  return {
    mission_id: input.mission_id,
    version: draft.version,
    draft_path: draftPath,
    completeness,
  };
}

// ---------------------------------------------------------------------------
// Extract Design Spec — requirements-draft → architectural design spec.
// ---------------------------------------------------------------------------

export interface ExtractDesignSpecOpInput {
  mission_id: string;
  project_name: string;
  requirements_draft_path?: string;
  additional_context?: string;
}

export async function extractDesignSpecOp(input: ExtractDesignSpecOpInput): Promise<{
  mission_id: string;
  version: string;
  draft_path: string;
  architecture_ready: { passed: boolean; reasons: string[] };
}> {
  if (!input.mission_id || !input.project_name) {
    throw new Error('[extract_design_spec] requires mission_id and project_name');
  }
  const backend = getReasoningBackend();
  const requirementsPath =
    input.requirements_draft_path
      ?? `active/missions/${input.mission_id}/evidence/requirements-draft.json`;
  const abs = pathResolver.rootResolve(requirementsPath);
  if (!safeExistsSync(abs)) {
    // Fall back to the store helper — may return null if evidence dir differs
    const fromStore = readRequirementsDraft(input.mission_id);
    if (!fromStore) {
      throw new Error(
        `[extract_design_spec] requirements draft not found at ${requirementsPath}`,
      );
    }
    const extracted = await backend.extractDesignSpec({
      requirementsDraft: fromStore,
      projectName: input.project_name,
      additionalContext: input.additional_context,
    });
    const saved = saveDesignSpec({
      missionId: input.mission_id,
      projectName: input.project_name,
      extracted,
      sourceRefs: [requirementsPath],
      generatedBy: backend.name,
    });
    const gate = evaluateArchitectureReadyGate(input.mission_id);
    return {
      mission_id: input.mission_id,
      version: saved.version,
      draft_path: `active/missions/${input.mission_id}/evidence/design-spec.json`,
      architecture_ready: gate,
    };
  }
  const requirementsDraft = JSON.parse(safeReadFile(abs, { encoding: 'utf8' }) as string);
  const extracted = await backend.extractDesignSpec({
    requirementsDraft,
    projectName: input.project_name,
    additionalContext: input.additional_context,
  });
  const saved = saveDesignSpec({
    missionId: input.mission_id,
    projectName: input.project_name,
    extracted,
    sourceRefs: [requirementsPath],
    generatedBy: backend.name,
  });
  const gate = evaluateArchitectureReadyGate(input.mission_id);
  return {
    mission_id: input.mission_id,
    version: saved.version,
    draft_path: `active/missions/${input.mission_id}/evidence/design-spec.json`,
    architecture_ready: gate,
  };
}

// ---------------------------------------------------------------------------
// Extract Test Plan — requirements (+ optional design) → test-case-adf cases.
// ---------------------------------------------------------------------------

export interface ExtractTestPlanOpInput {
  mission_id: string;
  project_name: string;
  app_id?: string;
  requirements_draft_path?: string;
  design_spec_path?: string;
}

export async function extractTestPlanOp(input: ExtractTestPlanOpInput): Promise<{
  mission_id: string;
  version: string;
  draft_path: string;
  qa_ready: { passed: boolean; reasons: string[] };
}> {
  if (!input.mission_id || !input.project_name) {
    throw new Error('[extract_test_plan] requires mission_id and project_name');
  }
  const backend = getReasoningBackend();
  const requirementsDraft =
    readRequirementsDraft(input.mission_id) ??
    (input.requirements_draft_path && safeExistsSync(pathResolver.rootResolve(input.requirements_draft_path))
      ? JSON.parse(safeReadFile(pathResolver.rootResolve(input.requirements_draft_path), { encoding: 'utf8' }) as string)
      : null);
  if (!requirementsDraft) {
    throw new Error('[extract_test_plan] requirements draft not found');
  }
  const designSpec =
    readDesignSpec(input.mission_id) ??
    (input.design_spec_path && safeExistsSync(pathResolver.rootResolve(input.design_spec_path))
      ? JSON.parse(safeReadFile(pathResolver.rootResolve(input.design_spec_path), { encoding: 'utf8' }) as string)
      : undefined);

  const extracted = await backend.extractTestPlan({
    requirementsDraft,
    designSpec,
    projectName: input.project_name,
    appId: input.app_id,
  });
  const saved = saveTestPlan({
    missionId: input.mission_id,
    projectName: input.project_name,
    extracted,
    sourceRefs: [
      `active/missions/${input.mission_id}/evidence/requirements-draft.json`,
      ...(designSpec ? [`active/missions/${input.mission_id}/evidence/design-spec.json`] : []),
    ],
    generatedBy: backend.name,
  });

  // Must-have FR ids for coverage check
  const mustHaveIds: string[] = Array.isArray((requirementsDraft as any).functional_requirements)
    ? ((requirementsDraft as any).functional_requirements as Array<{ id: string; priority: string }>)
        .filter((r) => r.priority === 'must')
        .map((r) => r.id)
    : [];
  const gate = evaluateQaReadyGate(input.mission_id, mustHaveIds);
  return {
    mission_id: input.mission_id,
    version: saved.version,
    draft_path: `active/missions/${input.mission_id}/evidence/test-plan.json`,
    qa_ready: gate,
  };
}

// ---------------------------------------------------------------------------
// Decompose Into Tasks — requirements (+ optional design) → task plan.
// ---------------------------------------------------------------------------

export interface DecomposeIntoTasksOpInput {
  mission_id: string;
  project_name: string;
  requirements_draft_path?: string;
  design_spec_path?: string;
}

export async function decomposeIntoTasksOp(input: DecomposeIntoTasksOpInput): Promise<{
  mission_id: string;
  version: string;
  draft_path: string;
  task_count: number;
  task_plan_ready: { passed: boolean; reasons: string[] };
}> {
  if (!input.mission_id || !input.project_name) {
    throw new Error('[decompose_into_tasks] requires mission_id and project_name');
  }
  const backend = getReasoningBackend();
  const requirementsDraft =
    readRequirementsDraft(input.mission_id) ??
    (input.requirements_draft_path && safeExistsSync(pathResolver.rootResolve(input.requirements_draft_path))
      ? JSON.parse(safeReadFile(pathResolver.rootResolve(input.requirements_draft_path), { encoding: 'utf8' }) as string)
      : null);
  if (!requirementsDraft) {
    throw new Error('[decompose_into_tasks] requirements draft not found');
  }
  const designSpec =
    readDesignSpec(input.mission_id) ??
    (input.design_spec_path && safeExistsSync(pathResolver.rootResolve(input.design_spec_path))
      ? JSON.parse(safeReadFile(pathResolver.rootResolve(input.design_spec_path), { encoding: 'utf8' }) as string)
      : undefined);

  const decomposed = await backend.decomposeIntoTasks({
    requirementsDraft,
    designSpec,
    projectName: input.project_name,
  });
  const saved = saveTaskPlan({
    missionId: input.mission_id,
    projectName: input.project_name,
    decomposed,
    sourceRefs: [
      `active/missions/${input.mission_id}/evidence/requirements-draft.json`,
      ...(designSpec ? [`active/missions/${input.mission_id}/evidence/design-spec.json`] : []),
    ],
    generatedBy: backend.name,
  });
  const gate = evaluateTaskPlanReadyGate(input.mission_id);
  return {
    mission_id: input.mission_id,
    version: saved.version,
    draft_path: `active/missions/${input.mission_id}/evidence/task-plan.json`,
    task_count: saved.tasks.length,
    task_plan_ready: gate,
  };
}

// ---------------------------------------------------------------------------
// Intuition Capture — records a 3-question heuristic entry under the
// confidential tier. See knowledge/public/orchestration/intuition-capture-protocol.md.
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
      '[capture_intuition] requires decision, anchor, and analogy (the three Intuition Capture answers)',
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
  logger.warn(`[DECISION_OPS:STUB] ${op} executed in stub mode${note ? ` — ${note}` : ''}. Replace with LLM/voice integration before production use.`);
}

// ---------------------------------------------------------------------------
// Pure-logic ops
// ---------------------------------------------------------------------------

/**
 * Sort stakeholder nodes by Power/Interest grid.
 * Input: array of { person_slug, power_level ('high'|'low'), interest_level ('high'|'low'), ... }
 * Output: ordered array, High-Power/High-Interest first, Low/Low last.
 */
export function stakeholderGridSort(nodes: any[]): any[] {
  const rank = (n: any): number => {
    const p = (n.power_level || n.power || 'low').toLowerCase();
    const i = (n.interest_level || n.interest || 'low').toLowerCase();
    if (p === 'high' && i === 'high') return 0;  // manage closely
    if (p === 'high' && i === 'low') return 1;   // keep satisfied
    if (p === 'low' && i === 'high') return 2;   // keep informed
    return 3;                                     // monitor
  };
  return [...nodes].sort((a, b) => rank(a) - rank(b));
}

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
  lines.push(`- Survived: ${survivedCount} / Rejected: ${rejectedCount} / Pending: ${pendingCount}`);
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
    lines.push(`${survivedCount} hypothes${survivedCount === 1 ? 'is' : 'es'} survived cross-critique and warrant further investigation.`);
  }
  if (rejectedCount > 0) {
    lines.push(`${rejectedCount} hypothes${rejectedCount === 1 ? 'is was' : 'es were'} rejected — see \`dissent-log.json\` for revisit triggers.`);
  }
  if (pendingCount > 0) {
    lines.push(`${pendingCount} hypothes${pendingCount === 1 ? 'is remains' : 'es remain'} pending (no critique pass yet).`);
  }
  lines.push('');

  safeMkdir(path.dirname(pathResolver.rootResolve(input.output_path)), { recursive: true });
  safeWriteFile(pathResolver.rootResolve(input.output_path), lines.join('\n'));
  return { written_to: input.output_path, sections: personaEntries.length };
}

/**
 * Aggregate nemawashi 1-on-1 visit files into a readiness matrix.
 * Expects visit files with { person_slug, stance, conditions, dissent_signals, visited_at }.
 */
export function computeReadinessMatrix(input: {
  visits_dir: string;
  proposal_ref?: string;
  deadline?: string;
  output_path: string;
}): { readiness_score: number; recommendation: 'proceed' | 'delay' | 'redesign'; written_to: string } {
  const dirAbs = pathResolver.rootResolve(input.visits_dir);
  const files = safeExistsSync(dirAbs)
    ? getAllFiles(dirAbs).filter((f) => f.endsWith('.json'))
    : [];

  const visits = files.map((f) => {
    try {
      return JSON.parse(safeReadFile(f, { encoding: 'utf8' }) as string);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const stanceWeight: Record<string, number> = {
    support: 100,
    conditional: 60,
    neutral: 40,
    oppose: 0,
  };

  const totalWeight = visits.reduce((sum: number, v: any) => sum + (stanceWeight[v.stance] ?? 30), 0);
  const readinessScore = visits.length === 0 ? 0 : Math.round(totalWeight / visits.length);

  let recommendation: 'proceed' | 'delay' | 'redesign';
  if (readinessScore >= 70) recommendation = 'proceed';
  else if (readinessScore >= 40) recommendation = 'delay';
  else recommendation = 'redesign';

  const payload = {
    proposal_ref: input.proposal_ref || null,
    deadline: input.deadline || null,
    visits: visits.map((v: any) => ({
      person_slug: v.person_slug,
      visited_at: v.visited_at,
      stance: v.stance,
      conditions: v.conditions || [],
      dissent_signals: v.dissent_signals || [],
    })),
    readiness_score: readinessScore,
    recommendation,
    generated_at: nowIso(),
  };
  writeJSON(input.output_path, payload);
  return { readiness_score: readinessScore, recommendation, written_to: input.output_path };
}

/**
 * Deterministic recommender that maps readiness_score to an action label.
 * No LLM — driven purely by the thresholds in readiness matrix output.
 */
export function recommend(input: {
  readiness_ref: string;
  options?: string[];
}): { choice: string; reason: string } {
  const matrix = readJSON<any>(input.readiness_ref);
  const score = Number(matrix.readiness_score ?? 0);
  const choice: string = matrix.recommendation || (
    score >= 70 ? 'proceed' : score >= 40 ? 'delay' : 'redesign'
  );
  const allowed = input.options || ['proceed', 'delay', 'redesign'];
  if (!allowed.includes(choice)) {
    return { choice: allowed[allowed.length - 1], reason: `score ${score} did not map to any allowed option; falling back` };
  }
  return { choice, reason: `readiness_score=${score}` };
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
    if (!b && a) { added.push(idx); continue; }
    if (b && !a) { removed.push(idx); continue; }
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
}): Promise<{ written_to: string }> {
  const backend = getReasoningBackend();
  const hypotheses = await backend.divergePersonas({
    topic: input.topic,
    personas: input.personas,
    minPerPersona: input.min_hypotheses_per_persona,
  });
  writeJSON(input.output_path, {
    topic: input.topic,
    hypotheses,
    generated_by: backend.name,
    generated_at: nowIso(),
  });
  return { written_to: input.output_path };
}

export async function crossCritique(input: {
  source_path: string;
  personas: string[];
  output_path: string;
}): Promise<{ written_to: string }> {
  const backend = getReasoningBackend();
  const src = readJSON<any>(input.source_path);
  const { hypotheses } = await backend.crossCritique({
    topic: src.topic,
    hypotheses: src.hypotheses ?? [],
    personas: input.personas,
  });
  writeJSON(input.output_path, {
    topic: src.topic,
    hypotheses,
    generated_by: backend.name,
    generated_at: nowIso(),
  });
  return { written_to: input.output_path };
}

export async function synthesizeCounterpartyPersona(input: {
  source_path: string;
  fidelity?: string;
}): Promise<{ persona_spec: any }> {
  const backend = getReasoningBackend();
  const node = readJSON<any>(input.source_path);
  const fidelity = (input.fidelity as 'low' | 'medium' | 'high') || 'high';
  const persona = await backend.synthesizePersona({
    relationshipNode: node,
    fidelity,
  });
  return { persona_spec: { ...persona, generated_by: backend.name } };
}

export async function a2aRoleplay(input: {
  persona: any;
  objective: string;
  time_budget_minutes: number;
  output_path: string;
}): Promise<{ written_to: string }> {
  const bridge = getVoiceBridge();
  const result = await bridge.runRoleplaySession({
    objective: input.objective,
    timeBudgetMinutes: input.time_budget_minutes,
    personaSpec: input.persona ?? {},
    outputPath: input.output_path,
  });
  writeJSON(input.output_path, {
    objective: input.objective,
    time_budget_minutes: input.time_budget_minutes,
    persona_identity: input.persona?.identity ?? null,
    turns: result.turns,
    engine_id: result.engine_id ?? null,
    generated_by: bridge.name,
    generated_at: nowIso(),
    ...(result._synthetic ? { _synthetic: true } : {}),
  });
  return { written_to: input.output_path };
}

export async function conduct1on1(input: {
  counterparty_ref: string;
  proposal_draft_ref: string;
  structure: string[];
  output_path: string;
}): Promise<{ written_to: string }> {
  const bridge = getVoiceBridge();
  const result = await bridge.runOneOnOneSession({
    counterpartyRef: input.counterparty_ref,
    proposalDraftRef: input.proposal_draft_ref,
    structure: input.structure,
    outputPath: input.output_path,
  });
  writeJSON(input.output_path, {
    person_slug: result.person_slug,
    visited_at: result.visited_at,
    structure: input.structure,
    transcript: result.transcript,
    stance: result.stance,
    conditions: result.conditions,
    dissent_signals: result.dissent_signals,
    engine_id: result.engine_id ?? null,
    generated_by: bridge.name,
    ...(result._synthetic ? { _synthetic: true } : {}),
  });
  return { written_to: input.output_path };
}

export function extractDissentSignals(input: {
  session_log_path: string;
  output_path: string;
}): { written_to: string } {
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
}): Promise<{ written_to: string; branch_count: number }> {
  const backend = getReasoningBackend();
  const src = readJSON<any>(input.source);
  const branches = await backend.forkBranches({
    hypotheses: src.hypotheses ?? [],
    executionProfile: input.execution_profile,
    costCapTokens: input.cost_cap_tokens,
    maxStepsPerBranch: input.max_steps_per_branch,
  });
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
  };
  const manifestPath = `${input.output_dir.replace(/\/$/, '')}/branches.manifest.json`;
  writeJSON(manifestPath, manifest);
  return { written_to: manifestPath, branch_count: rebased.length };
}

export async function simulateAll(input: {
  manifest_path?: string;
  goal: string;
  output_dir: string;
}): Promise<{ written_to: string; quality_written_to: string; quality_severity: 'ok' | 'warn' | 'poor' }> {
  const backend = getReasoningBackend();
  const manifest = input.manifest_path && safeExistsSync(pathResolver.rootResolve(input.manifest_path))
    ? readJSON<any>(input.manifest_path)
    : { branches: [] };
  const { branches: simulated } = await backend.simulateBranches({
    branches: manifest.branches ?? [],
    goal: input.goal,
  });
  const summary = {
    goal: input.goal,
    branches: simulated,
    generated_by: backend.name,
    timestamp: nowIso(),
  };
  const outDir = input.output_dir.replace(/\/$/, '');
  const outPath = `${outDir}/simulation-summary.json`;
  writeJSON(outPath, summary);

  const quality = evaluateSimulationQuality(summary);
  const qualityPath = `${outDir}/simulation-quality.json`;
  writeJSON(qualityPath, quality);

  return {
    written_to: outPath,
    quality_written_to: qualityPath,
    quality_severity: quality.severity,
  };
}

// ---------------------------------------------------------------------------
// Meeting facilitation ops (G6 / new use case)
//
// extract_action_items / generate_facilitation_script / generate_reminder_message
// drive the AI-runs-meetings flow. They use `backend.delegateTask` (which
// every reasoning backend implements) so they work uniformly across stub /
// claude-cli / claude-agent / anthropic / gemini-cli / codex-cli.
// ---------------------------------------------------------------------------

function extractFirstJsonBlock(text: string): unknown {
  const trimmed = text.trim();
  // Extract JSON inside a code fence first.
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  // Fallback: locate the first top-level {...} or [...].
  const start = trimmed.search(/[\[{]/);
  if (start === -1) throw new Error('no JSON block in delegateTask response');
  const open = trimmed[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === open) depth += 1;
    else if (trimmed[i] === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error('unbalanced JSON block in delegateTask response');
}

export async function extractActionItemsOp(input: {
  mission_id: string;
  transcript: string;
  attendees?: Array<{
    name: string;
    person_slug?: string;
    channel_handle?: string;
    manager_handle?: string;
  }>;
  operator_label?: string;
  default_assignee_label?: string;
  language?: string;
  default_max_reminders?: number;
  /**
   * Ops-3: when true, every extracted item is recorded with
   * `partial_state=true` so it fail-closes self-execution / tracking
   * until cleared. Set this when the upstream listen result reported
   * `partial_state` (bridge timeout, dropped capture, empty transcript).
   */
  partial_state?: boolean;
  partial_reason?: string;
  /**
   * Compliance-2: when true, run each item through the restricted-action-kinds
   * policy and tag matches with `restricted` + `restriction_rule_id`. Defaults
   * to true; supply false only for closed-loop tests.
   */
  enforce_restricted_actions?: boolean;
}): Promise<{
  items: ActionItem[];
  written_count: number;
  pending_review_count: number;
  partial_count: number;
  restricted_count: number;
}> {
  const backend = getReasoningBackend();
  const operatorLabel = input.operator_label ?? 'Operator';
  const attendees = input.attendees ?? [];
  const attendeesBlock = attendees.length
    ? attendees
        .map(
          (a) =>
            `  - ${a.name}${a.person_slug ? ` (slug=${a.person_slug})` : ''}${
              a.channel_handle ? ` (channel=${a.channel_handle})` : ''
            }`,
        )
        .join('\n')
    : '  (none provided)';
  const language = input.language ?? 'auto';
  const defaultMaxReminders = input.default_max_reminders ?? 5;
  const prompt = [
    'You analyze a meeting transcript and produce a JSON array of action items.',
    '',
    'Output rules:',
    '- Output ONLY a JSON array. No prose. No code fence.',
    '- Each item: { "title": str (≤120 chars, imperative), "summary": str?, "assignee_label": str, "assignee_kind": "operator_self"|"team_member"|"external"|"unassigned", "priority": "must"|"should"|"could"|"wont", "due_at_iso": str?, "modality": "declarative"|"conditional"|"hypothetical"|"rhetorical"|"humor", "speaker_label": str, "transcript_excerpt": str (≤240 chars, verbatim), "transcript_offset_lines": [int] }',
    '',
    `- assignee_kind = "operator_self" when the assignee matches "${operatorLabel}".`,
    '- assignee_kind = "team_member" when the assignee is in the attendees list (not the operator).',
    '- assignee_kind = "external" when the assignee is named but not in the attendee list.',
    '- assignee_kind = "unassigned" when the action item has no clear owner.',
    '',
    'CRITICAL — modality classification (audit-load-bearing):',
    '- "declarative"  : a clear commitment ("I will send X by Friday").',
    '- "conditional"  : depends on a precondition not yet met ("if budget approves, then …").',
    '- "hypothetical" : exploratory or thought-experiment ("we could try …", "what if we …").',
    '- "rhetorical"   : framed as a question but not requesting action ("should we even do this?").',
    '- "humor"        : a joke / sarcasm / reductio ad absurdum ("let\\u0027s just delete prod").',
    'When modality != "declarative", the item lands in pending_speaker_review and will NOT be auto-executed or auto-tracked. Be conservative: if uncertain whether a sentence is a real commitment, label "conditional" or "hypothetical" rather than "declarative".',
    '',
    '- speaker_label: who actually uttered the words (one of the attendees, the operator, or "unknown").',
    '- transcript_excerpt: a verbatim ≤ 240-char excerpt of the source line(s).',
    '- transcript_offset_lines: 1-based line numbers in the transcript referenced by this item.',
    '',
    '- Capture imperatives, owners, and any deadlines; do not invent owners or deadlines that are not in the transcript.',
    '',
    'Attendees:',
    attendeesBlock,
    '',
    'Transcript:',
    input.transcript,
    '',
    `Language hint: ${language}.`,
  ].join('\n');
  const extractedAt = nowIso();
  const raw = await backend.delegateTask(prompt, `mission=${input.mission_id}`);
  let parsed: any[];
  try {
    parsed = extractFirstJsonBlock(raw) as any[];
    if (!Array.isArray(parsed)) {
      throw new Error('expected array');
    }
  } catch (err: any) {
    logger.warn(`[extract_action_items] parse failed: ${err?.message ?? err}; raw="${raw.slice(0, 200)}"`);
    return {
      items: [],
      written_count: 0,
      pending_review_count: 0,
      partial_count: 0,
      restricted_count: 0,
    };
  }

  const operatorTokens = new Set([operatorLabel.toLowerCase(), 'operator', 'self', 'me']);
  const validModalities = new Set(['declarative', 'conditional', 'hypothetical', 'rhetorical', 'humor']);
  const items: ActionItem[] = [];
  let i = 0;
  let pendingReview = 0;
  let restrictedCount = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const title = String(entry.title ?? '').trim();
    if (title.length < 5) continue;
    const assigneeLabel = String(
      entry.assignee_label ?? input.default_assignee_label ?? 'unassigned',
    ).trim() || 'unassigned';
    let kind: ActionItemAssigneeKind =
      entry.assignee_kind &&
      ['operator_self', 'team_member', 'external', 'unassigned'].includes(entry.assignee_kind)
        ? (entry.assignee_kind as ActionItemAssigneeKind)
        : 'unassigned';
    if (kind === 'unassigned' && operatorTokens.has(assigneeLabel.toLowerCase())) {
      kind = 'operator_self';
    }
    const matchedAttendee = attendees.find(
      (a) => a.name.toLowerCase() === assigneeLabel.toLowerCase(),
    );
    if (matchedAttendee && kind !== 'operator_self') {
      kind = 'team_member';
    }
    const assignee: ActionItemAssignee = {
      kind,
      label: assigneeLabel,
      ...(matchedAttendee?.person_slug ? { person_slug: matchedAttendee.person_slug } : {}),
      ...(matchedAttendee?.channel_handle
        ? { channel_handle: matchedAttendee.channel_handle }
        : {}),
    };
    // HR-2 chain-of-command: lift the manager handle off the matched
    // attendee record. The reminder dispatcher CCs this when priority
    // is `must` or when the per-tenant policy demands manager visibility.
    const managerHandle = matchedAttendee?.manager_handle;
    const modality: ActionItemModality = validModalities.has(String(entry.modality))
      ? (entry.modality as ActionItemModality)
      : 'declarative';
    const reviewState: ActionItemReviewState =
      modality === 'declarative' ? 'auto_committed' : 'pending_speaker_review';
    if (reviewState === 'pending_speaker_review') pendingReview += 1;
    const provenance: ActionItemProvenance = {
      ...(typeof entry.speaker_label === 'string' ? { speaker_label: entry.speaker_label } : {}),
      ...(typeof entry.transcript_excerpt === 'string'
        ? { transcript_excerpt: String(entry.transcript_excerpt).slice(0, 240) }
        : {}),
      ...(Array.isArray(entry.transcript_offset_lines)
        ? {
            transcript_offset_lines: entry.transcript_offset_lines
              .map((n: unknown) => Number(n))
              .filter((n: number) => Number.isFinite(n) && n > 0),
          }
        : {}),
      extractor: {
        backend: backend.name,
        model: process.env.KYBERION_CLAUDE_CLI_MODEL || 'opus',
        extracted_at: extractedAt,
      },
    };
    i += 1;
    const itemId = nextActionItemId(input.mission_id, `M${i}`);
    // Compliance-2: classify against restricted-action-kinds policy.
    const restrictedHit =
      input.enforce_restricted_actions === false
        ? null
        : matchRestrictedAction({
            title: title.slice(0, 120),
            summary: typeof entry.summary === 'string' ? entry.summary : undefined,
          });
    if (restrictedHit) restrictedCount += 1;
    const summaryParts: string[] = [];
    if (typeof entry.summary === 'string') summaryParts.push(entry.summary);
    if (input.partial_state && input.partial_reason) {
      summaryParts.push(`[partial_state] ${input.partial_reason}`);
    }
    const policy: Record<string, unknown> = {};
    if (input.partial_state) policy.partial_state = true;
    if (restrictedHit) {
      policy.restricted = true;
      policy.restriction_rule_id = restrictedHit.id;
    }
    if (managerHandle) policy.manager_handle = managerHandle;
    const recorded = recordActionItem({
      item_id: itemId,
      mission_id: input.mission_id,
      title: title.slice(0, 120),
      ...(summaryParts.length ? { summary: summaryParts.join('\n') } : {}),
      assignee,
      ...(entry.priority &&
      ['must', 'should', 'could', 'wont'].includes(entry.priority)
        ? { priority: entry.priority }
        : {}),
      ...(entry.due_at_iso ? { due_at: entry.due_at_iso } : {}),
      modality,
      review_state: reviewState,
      provenance,
      max_reminders: defaultMaxReminders,
      ...(Object.keys(policy).length ? { policy } : {}),
    });
    items.push(recorded);
  }
  return {
    items,
    written_count: items.length,
    pending_review_count: pendingReview,
    partial_count: input.partial_state ? items.length : 0,
    restricted_count: restrictedCount,
  };
}

export async function generateFacilitationScriptOp(input: {
  agenda?: string[];
  current_topic?: string;
  recent_transcript_chunk?: string;
  remaining_minutes?: number;
  facilitator_persona_label?: string;
  language?: string;
}): Promise<{ speech_text: string; next_action: 'continue_listen' | 'transition_topic' | 'wrap_up' | 'pause' }> {
  const backend = getReasoningBackend();
  const persona = input.facilitator_persona_label ?? 'a calm professional facilitator';
  const remaining = input.remaining_minutes ?? 30;
  const agendaBlock = (input.agenda ?? []).map((a, i) => `  ${i + 1}. ${a}`).join('\n') || '  (no agenda provided)';
  const language = input.language ?? 'ja';
  const prompt = [
    `You generate the next short facilitation utterance for ${persona} in an online meeting.`,
    'Output ONLY a JSON object: { "speech_text": str (≤ 2 sentences), "next_action": "continue_listen"|"transition_topic"|"wrap_up"|"pause" }',
    'No prose, no code fence.',
    `Language: ${language}. Be concise. Do not name people unless the transcript names them. Do not introduce facts not in the transcript.`,
    '',
    'Agenda:',
    agendaBlock,
    '',
    `Current topic: ${input.current_topic ?? '(unspecified)'}`,
    `Time remaining: ${remaining} minutes.`,
    '',
    'Recent transcript chunk:',
    input.recent_transcript_chunk ?? '(silence so far)',
  ].join('\n');
  const raw = await backend.delegateTask(prompt, 'meeting-facilitation');
  try {
    const parsed = extractFirstJsonBlock(raw) as any;
    const speech = typeof parsed.speech_text === 'string' ? parsed.speech_text : '';
    const next =
      parsed.next_action &&
      ['continue_listen', 'transition_topic', 'wrap_up', 'pause'].includes(parsed.next_action)
        ? parsed.next_action
        : 'continue_listen';
    return { speech_text: speech, next_action: next };
  } catch (err: any) {
    logger.warn(`[generate_facilitation_script] parse failed: ${err?.message ?? err}`);
    return { speech_text: '', next_action: 'continue_listen' };
  }
}

/**
 * Compliance-2 approval gate.
 *
 * Partition pending items into `allowed` (free to proceed) and
 * `blocked` (restricted + not approved + no sudo). The caller marks
 * blocked items as `blocked` in the store and proceeds to dispatch
 * the rest. Pure function so the dispatch loop is testable.
 */
export function applyRestrictedActionGate(
  items: ActionItem[],
  opts: { approved_item_ids: ReadonlySet<string>; sudo_override: boolean },
): {
  allowed: ActionItem[];
  blocked: Array<{
    item: ActionItem;
    rule_id?: string;
    reason: string;
  }>;
} {
  const allowed: ActionItem[] = [];
  const blocked: Array<{ item: ActionItem; rule_id?: string; reason: string }> = [];
  for (const item of items) {
    if (
      item.policy?.restricted &&
      !opts.sudo_override &&
      !opts.approved_item_ids.has(item.item_id)
    ) {
      const ruleId = item.policy?.restriction_rule_id;
      blocked.push({
        item,
        ...(ruleId ? { rule_id: ruleId } : {}),
        reason: `restricted-action-kinds gate: rule=${ruleId ?? 'unknown'}; set KYBERION_RESTRICTED_APPROVED_ITEMS or KYBERION_SUDO to release`,
      });
      continue;
    }
    allowed.push(item);
  }
  return { allowed, blocked };
}

/**
 * Execute every operator_self pending item: gate restricted items,
 * then for each allowed item, mark in_progress, delegate the plan to
 * the reasoning backend, and transition to completed (or blocked on
 * failure). Returns a structured report; mutates the action-item
 * store via `updateActionItemStatus`.
 */
export async function executeSelfActionItemsOp(input: {
  mission_id: string;
  language?: string;
  policy?: MeetingFacilitatorPolicy;
}): Promise<{
  mission_id: string;
  dispatched: Array<{ item_id: string; title: string; plan: string }>;
  skipped_restricted: Array<{ item_id: string; title: string; restriction_rule_id?: string }>;
  generated_at: string;
}> {
  const language = input.language ?? 'ja';
  const policy = input.policy ?? loadMeetingFacilitatorPolicy();
  const pending = listOperatorSelfPending(input.mission_id);
  const { allowed, blocked } = applyRestrictedActionGate(pending, {
    approved_item_ids: policy.restricted_approved_item_ids,
    sudo_override: policy.sudo_override,
  });
  const skippedRestricted = blocked.map(({ item, rule_id, reason }) => {
    updateActionItemStatus({
      mission_id: input.mission_id,
      item_id: item.item_id,
      status: 'blocked',
      blocked_reason: reason,
      execution: { executed_via: 'agent_delegate', result_summary: reason },
    });
    return {
      item_id: item.item_id,
      title: item.title,
      ...(rule_id ? { restriction_rule_id: rule_id } : {}),
    };
  });

  const backend = getReasoningBackend();
  const dispatched: Array<{ item_id: string; title: string; plan: string }> = [];
  for (const item of allowed) {
    updateActionItemStatus({
      mission_id: input.mission_id,
      item_id: item.item_id,
      status: 'in_progress',
    });
    let plan = '';
    try {
      plan = await backend.delegateTask(
        [
          `You are dispatching an action item to the operator. Output ONLY a JSON object: { "plan": str (≤ 5 sentences), "completion_summary": str (≤ 3 sentences) }.`,
          `No prose, no code fence. Language: ${language}.`,
          `Action item title: "${item.title}".`,
          item.summary ? `Summary: ${item.summary}` : '',
          item.due_at ? `Due: ${item.due_at}.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        `self-exec:${item.item_id}`,
      );
      let summary = '';
      try {
        const parsed = extractFirstJsonBlock(plan) as any;
        if (typeof parsed.completion_summary === 'string') summary = parsed.completion_summary;
        if (typeof parsed.plan === 'string') plan = parsed.plan;
      } catch {
        /* keep raw plan */
      }
      updateActionItemStatus({
        mission_id: input.mission_id,
        item_id: item.item_id,
        status: 'completed',
        execution: {
          executed_via: 'agent_delegate',
          execution_ref: `delegateTask:self-exec:${item.item_id}`,
          ...(summary ? { result_summary: summary } : {}),
        },
      });
    } catch (err: any) {
      updateActionItemStatus({
        mission_id: input.mission_id,
        item_id: item.item_id,
        status: 'blocked',
        blocked_reason: `delegateTask failed: ${err?.message ?? err}`,
        execution: {
          executed_via: 'agent_delegate',
          result_summary: `delegateTask failed: ${err?.message ?? err}`,
        },
      });
    }
    dispatched.push({ item_id: item.item_id, title: item.title, plan });
  }
  return {
    mission_id: input.mission_id,
    dispatched,
    skipped_restricted: skippedRestricted,
    generated_at: nowIso(),
  };
}

/**
 * Track every team_member pending item: per-item, generate a reminder
 * message, persist it as a `primary` reminder, and append `cc_manager`
 * reminders for any HR-2 escalation channel returned by
 * `generateReminderMessageOp`. Returns the report; mutates the store.
 */
export async function trackPendingActionItemsOp(input: {
  mission_id: string;
  tone?: 'friendly' | 'formal' | 'urgent';
  language?: string;
  max_items?: number;
  policy?: MeetingFacilitatorPolicy;
}): Promise<{
  mission_id: string;
  scanned: number;
  reminded: Array<{
    item_id: string;
    channel: string;
    days_overdue: number;
    cc?: string[];
  }>;
  generated_at: string;
}> {
  const tone = input.tone ?? 'friendly';
  const language = input.language ?? 'ja';
  const maxItems = input.max_items ?? 20;
  const policy = input.policy ?? loadMeetingFacilitatorPolicy();
  const pending = listOthersPending(input.mission_id).slice(0, maxItems);
  const now = new Date();
  const reminded: Array<{
    item_id: string;
    channel: string;
    days_overdue: number;
    cc?: string[];
  }> = [];
  for (const item of pending) {
    const dueAt = item.due_at ? new Date(item.due_at) : null;
    const daysOverdue = dueAt
      ? Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / (24 * 60 * 60 * 1000)))
      : 0;
    const reminder = await generateReminderMessageOp({
      item,
      days_overdue: daysOverdue,
      tone,
      language,
      policy,
    });
    appendReminder({
      mission_id: input.mission_id,
      item_id: item.item_id,
      reminder: {
        sent_at: now.toISOString(),
        channel: reminder.channel,
        message: reminder.text,
        relationship: 'primary',
      },
    });
    if (reminder.cc && reminder.cc.length) {
      for (const ccChannel of reminder.cc) {
        appendReminder({
          mission_id: input.mission_id,
          item_id: item.item_id,
          reminder: {
            sent_at: now.toISOString(),
            channel: ccChannel,
            message: reminder.text,
            relationship: 'cc_manager',
          },
        });
      }
    }
    reminded.push({
      item_id: item.item_id,
      channel: reminder.channel,
      days_overdue: daysOverdue,
      ...(reminder.cc && reminder.cc.length ? { cc: reminder.cc } : {}),
    });
  }
  return {
    mission_id: input.mission_id,
    scanned: pending.length,
    reminded,
    generated_at: nowIso(),
  };
}

/**
 * HR-3 speaker fairness audit. Aggregates `provenance.speaker_label`
 * across the mission and emits a share-of-voice report. Pure read —
 * does not mutate the store. Defaults the dominance thresholds to
 * the values from the meeting-facilitator outcome simulation; callers
 * can override (per-tenant configurations).
 */
export interface SpeakerFairnessReport {
  mission_id: string;
  total_items: number;
  attributed_items: number;
  unattributed_items: number;
  distribution: Array<{
    speaker: string;
    total: number;
    must: number;
    share_total: number;
    share_must: number;
  }>;
  dominant_speaker: string | null;
  warn: boolean;
  warn_reason: string | null;
  generated_at: string;
}

export function auditSpeakerFairnessOp(input: {
  mission_id: string;
  policy?: MeetingFacilitatorPolicy;
  /** Per-call override; takes precedence over `policy.speaker_fairness_total_threshold`. */
  total_threshold?: number;
  /** Per-call override; takes precedence over `policy.speaker_fairness_must_threshold`. */
  must_threshold?: number;
}): SpeakerFairnessReport {
  const policy = input.policy ?? loadMeetingFacilitatorPolicy();
  const items = listActionItems(input.mission_id);
  const counts: Record<string, { total: number; must: number }> = {};
  let totalAttributed = 0;
  let mustAttributed = 0;
  for (const it of items) {
    const speaker = it.provenance?.speaker_label?.trim();
    if (!speaker) continue;
    if (!counts[speaker]) counts[speaker] = { total: 0, must: 0 };
    counts[speaker].total += 1;
    totalAttributed += 1;
    if (it.priority === 'must') {
      counts[speaker].must += 1;
      mustAttributed += 1;
    }
  }
  const distribution = Object.entries(counts)
    .map(([speaker, c]) => ({
      speaker,
      total: c.total,
      must: c.must,
      share_total: totalAttributed ? c.total / totalAttributed : 0,
      share_must: mustAttributed ? c.must / mustAttributed : 0,
    }))
    .sort((a, b) => b.total - a.total);
  const dominant = distribution[0];
  const totalThreshold = input.total_threshold ?? policy.speaker_fairness_total_threshold;
  const mustThreshold = input.must_threshold ?? policy.speaker_fairness_must_threshold;
  const warn = Boolean(
    dominant &&
      (dominant.share_total > totalThreshold || dominant.share_must > mustThreshold),
  );
  return {
    mission_id: input.mission_id,
    total_items: items.length,
    attributed_items: totalAttributed,
    unattributed_items: items.length - totalAttributed,
    distribution,
    dominant_speaker: dominant?.speaker ?? null,
    warn,
    warn_reason: warn
      ? `dominant speaker '${dominant!.speaker}' has share_total=${dominant!.share_total.toFixed(2)}, share_must=${dominant!.share_must.toFixed(2)}`
      : null,
    generated_at: nowIso(),
  };
}

export async function generateReminderMessageOp(input: {
  item: ActionItem;
  days_overdue?: number;
  tone?: 'friendly' | 'formal' | 'urgent';
  language?: string;
  policy?: MeetingFacilitatorPolicy;
}): Promise<{ channel: string; text: string; cc?: string[] }> {
  const backend = getReasoningBackend();
  const tone = input.tone ?? 'friendly';
  const language = input.language ?? 'ja';
  const channel = input.item.assignee.channel_handle ?? 'unspecified';
  const overdue = input.days_overdue ?? 0;
  const policy = input.policy ?? loadMeetingFacilitatorPolicy();
  const prompt = [
    'You draft a SHORT reminder message about an outstanding action item.',
    'Output ONLY a JSON object: { "text": str (≤ 3 sentences) }',
    'No prose, no code fence.',
    `Tone: ${tone}. Language: ${language}.`,
    `Recipient label: ${input.item.assignee.label}.`,
    `Action item: "${input.item.title}".`,
    input.item.due_at ? `Original due: ${input.item.due_at}.` : 'No firm deadline was set.',
    overdue > 0 ? `Days overdue: ${overdue}.` : 'Not yet overdue, this is a check-in.',
    'Do not threaten escalation. Do not invent context. Suggest one concrete next step.',
  ].join('\n');
  const raw = await backend.delegateTask(prompt, `reminder:${input.item.item_id}`);
  let text = '';
  try {
    const parsed = extractFirstJsonBlock(raw) as any;
    text = typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    // Fall back to a deterministic template if parse fails.
    text = `Reminder: ${input.item.title}.${input.item.due_at ? ` Original due ${input.item.due_at}.` : ''}`;
  }
  // HR-2 chain-of-command: CC the manager handle when priority=must,
  // when the recipient has missed the reminder several times, or when
  // the action item is restricted. Threshold lives in the
  // MeetingFacilitatorPolicy (defaults to 3 from the env var).
  const cc: string[] = [];
  const managerHandle = input.item.policy?.manager_handle;
  if (managerHandle) {
    const sent = input.item.reminders?.length ?? 0;
    const shouldCc =
      input.item.priority === 'must' ||
      input.item.policy?.restricted === true ||
      sent >= policy.reminder_cc_after_n;
    if (shouldCc) cc.push(managerHandle);
  }
  return { channel, text, ...(cc.length ? { cc } : {}) };
}

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
}> {
  if (!Number.isInteger(input.runs) || input.runs < 2) {
    throw new Error('[simulateAllEnsemble] runs must be an integer >= 2');
  }
  const outDir = input.output_dir.replace(/\/$/, '');
  const runsDir = `${outDir}/ensemble-runs`;
  safeMkdir(pathResolver.rootResolve(runsDir), { recursive: true });

  const runs: any[] = [];
  for (let i = 0; i < input.runs; i++) {
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
  };
  const ensemblePath = `${outDir}/simulation-ensemble.json`;
  writeJSON(ensemblePath, ensemble);

  return {
    ensemble_written_to: ensemblePath,
    individual_runs_dir: runsDir,
    convergence_severity: convergence.severity,
    divergent_outcomes_warning: convergence.divergent_outcomes_warning,
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
    const ties = ['failure', 'success', 'pending'].filter(
      (k) => (counts as any)[k] === max,
    );
    if (ties.length === 1) dominant = ties[0] as any;
    perBranch.push({
      branch_id: branchId,
      runs_seen: seen,
      outcome_counts: { ...counts },
      dominant_outcome: dominant,
      convergence: total > 0 ? max / total : 0,
    });
  }
  const meanConvergence = perBranch.length === 0
    ? 1
    : perBranch.reduce((acc, b) => acc + b.convergence, 0) / perBranch.length;
  const divergentWarning = meanConvergence < threshold;
  const severity: 'ok' | 'warn' | 'poor' = perBranch.length === 0
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
    detail: branches.length > 0
      ? `${branches.length} branches simulated`
      : 'simulation produced zero branches',
  });

  // Hard 2 — no branch may report both a failure and a success mode (logical XOR).
  const xorViolators = branches.filter(
    (b) => b.first_failure_mode && b.first_success_mode,
  );
  checks.push({
    id: 'failure_xor_success',
    severity: 'hard',
    passed: xorViolators.length === 0,
    detail: xorViolators.length === 0
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
    detail: dupCount === 0
      ? 'branch ids are unique'
      : `${dupCount} duplicate branch_id values detected`,
  });

  // Soft 4 — at least one branch must reach a terminal mode (otherwise the
  // simulation produced no usable signal).
  const terminated = branches.filter(
    (b) => b.first_failure_mode || b.first_success_mode,
  );
  checks.push({
    id: 'reaches_terminal_mode',
    severity: 'soft',
    passed: terminated.length > 0,
    detail: terminated.length > 0
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
    (b) => b.terminated_at_step !== null && b.terminated_at_step <= 0,
  );
  checks.push({
    id: 'non_trivial_termination_depth',
    severity: 'soft',
    passed: zeroDepth.length === 0,
    detail: zeroDepth.length === 0
      ? 'all terminated branches reached at least one step'
      : `${zeroDepth.length} branches terminated at step <= 0 (likely vacuous)`,
  });

  const hardFailed = checks.some((c) => c.severity === 'hard' && !c.passed);
  const softFailed = checks.some((c) => c.severity === 'soft' && !c.passed);
  const severity: 'ok' | 'warn' | 'poor' = hardFailed
    ? 'poor'
    : softFailed
      ? 'warn'
      : 'ok';

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
]);

export async function dispatchDecisionOp(
  op: string,
  params: any,
  ctx: Ctx,
): Promise<{ handled: boolean; ctx: Ctx }> {
  const resolved = (k: string) => resolveVars(params[k], ctx);
  const exportAs = params.export_as;
  /**
   * Behavior: if `export_as` is set, the entire result lands at
   * `ctx[exportAs]`. Otherwise — if the result is a plain object —
   * its keys are merged into `ctx` so subsequent steps can reference
   * `{{key}}` directly. This was previously a silent-drop, which made
   * pipeline templating surprising; the merge is strictly additive.
   */
  const assign = (value: any): Ctx => {
    if (exportAs) return { ...ctx, [exportAs]: value };
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      return { ...ctx, ...(value as Record<string, unknown>) };
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
      const nodes = Array.isArray(params.nodes) ? params.nodes : (ctx[params.from || 'stakeholder_nodes'] || []);
      const sorted = stakeholderGridSort(nodes);
      return { handled: true, ctx: assign(sorted) };
    }

    case 'find_slides_by_owner': {
      const slides = Array.isArray(params.slides) ? params.slides : (ctx[params.slides_from || 'slides'] || ctx['last_pptx_slides'] || []);
      const ownerLabels: string[] = params.owner_labels
        || (params.owner_label ? [params.owner_label] : [])
        || ctx[params.owner_labels_from || 'owner_labels']
        || [];
      const result = findSlidesByOwner({
        slides,
        owner_labels: ownerLabels,
        match_mode: params.match_mode,
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'pptx_diff': {
      const before = Array.isArray(params.before) ? params.before : (ctx[params.before_from || 'before_slides'] || []);
      const after = Array.isArray(params.after) ? params.after : (ctx[params.after_from || 'after_slides'] || []);
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

    case 'inject_prior_knowledge': {
      const topic = resolved('topic') || '';
      const tagsParam = resolved('tags');
      const tags = Array.isArray(tagsParam) ? tagsParam : [];
      const limit = Number(resolved('limit')) || 5;
      const minScore = params.min_score !== undefined
        ? Number(resolved('min_score'))
        : 0.0001;
      const entries = findRelevantDistilledKnowledge({
        topic,
        tags,
        limit,
        minScore,
      });
      const summary = entries.length === 0
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

    case 'extract_action_items': {
      const transcriptPath = resolved('transcript_path');
      const transcript = transcriptPath
        ? (safeReadFile(pathResolver.rootResolve(transcriptPath), { encoding: 'utf8' }) as string)
        : (resolved('transcript') as string) || '';
      // Resolve `attendees` template; fall back to context value or empty.
      const attendeesResolved = resolved('attendees');
      const attendees = Array.isArray(attendeesResolved)
        ? attendeesResolved
        : Array.isArray(ctx[params.attendees_from || 'attendees'])
          ? (ctx[params.attendees_from || 'attendees'] as any[])
          : [];
      // Ops-3: propagate partial_state from the upstream listen step.
      // Two channels are supported: (a) explicit params, (b) the
      // listen_result object that meeting-actuator pushes into ctx.
      const listenResult = ctx['listen_result'] || ctx['meeting_listen_result'];
      const partialFromCtx =
        listenResult && typeof listenResult === 'object'
          ? Boolean((listenResult as any).partial_state)
          : false;
      const partialReasonFromCtx =
        listenResult && typeof listenResult === 'object'
          ? ((listenResult as any).partial_reason as string | undefined)
          : undefined;
      const partialState =
        params.partial_state !== undefined
          ? Boolean(resolved('partial_state'))
          : partialFromCtx;
      const partialReason =
        params.partial_reason !== undefined
          ? String(resolved('partial_reason') ?? '')
          : partialReasonFromCtx;
      const result = await extractActionItemsOp({
        mission_id: resolved('mission_id') || process.env.MISSION_ID || '',
        transcript,
        attendees,
        ...(params.operator_label
          ? { operator_label: resolved('operator_label') }
          : {}),
        ...(params.default_assignee_label
          ? { default_assignee_label: resolved('default_assignee_label') }
          : {}),
        ...(params.language ? { language: resolved('language') } : {}),
        ...(partialState ? { partial_state: true } : {}),
        ...(partialReason ? { partial_reason: partialReason } : {}),
        ...(params.enforce_restricted_actions !== undefined
          ? { enforce_restricted_actions: Boolean(resolved('enforce_restricted_actions')) }
          : {}),
      });
      const outputPath = resolved('output_path');
      if (outputPath) {
        writeJSON(outputPath, {
          items: result.items,
          written_count: result.written_count,
          partial_count: result.partial_count,
          restricted_count: result.restricted_count,
          generated_at: nowIso(),
        });
      }
      return {
        handled: true,
        ctx: assign({
          extracted_action_items: result.items,
          action_item_count: result.written_count,
          partial_action_item_count: result.partial_count,
          restricted_action_item_count: result.restricted_count,
          ...(outputPath ? { written_to: outputPath } : {}),
        }),
      };
    }

    case 'generate_facilitation_script': {
      const result = await generateFacilitationScriptOp({
        agenda: Array.isArray(params.agenda) ? params.agenda : undefined,
        ...(params.current_topic ? { current_topic: resolved('current_topic') } : {}),
        ...(params.recent_transcript_chunk
          ? { recent_transcript_chunk: resolved('recent_transcript_chunk') }
          : {}),
        ...(params.remaining_minutes !== undefined
          ? { remaining_minutes: Number(resolved('remaining_minutes')) }
          : {}),
        ...(params.facilitator_persona_label
          ? { facilitator_persona_label: resolved('facilitator_persona_label') }
          : {}),
        ...(params.language ? { language: resolved('language') } : {}),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'generate_reminder_message': {
      const item = params.item ?? ctx[params.item_from || 'item'];
      if (!item || typeof item !== 'object') {
        throw new Error('generate_reminder_message: missing params.item (ActionItem)');
      }
      const result = await generateReminderMessageOp({
        item: item as ActionItem,
        ...(params.days_overdue !== undefined
          ? { days_overdue: Number(resolved('days_overdue')) }
          : {}),
        ...(params.tone ? { tone: resolved('tone') } : {}),
        ...(params.language ? { language: resolved('language') } : {}),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'execute_self_action_items': {
      const missionId = resolved('mission_id') || process.env.MISSION_ID || '';
      if (!missionId) {
        throw new Error('execute_self_action_items: mission_id is required');
      }
      const result = await executeSelfActionItemsOp({
        mission_id: missionId,
        language: resolved('language') || 'ja',
      });
      const outputPath = resolved('output_path');
      const report = {
        mission_id: result.mission_id,
        dispatched: result.dispatched.length,
        skipped_restricted: result.skipped_restricted.length,
        items: result.dispatched,
        skipped_items: result.skipped_restricted,
        generated_at: result.generated_at,
      };
      if (outputPath) writeJSON(outputPath, report);
      return {
        handled: true,
        ctx: assign({
          ...(outputPath ? { written_to: outputPath } : {}),
          dispatched_count: result.dispatched.length,
          skipped_restricted_count: result.skipped_restricted.length,
        }),
      };
    }

    case 'track_pending_action_items': {
      const missionId = resolved('mission_id') || process.env.MISSION_ID || '';
      if (!missionId) {
        throw new Error('track_pending_action_items: mission_id is required');
      }
      const result = await trackPendingActionItemsOp({
        mission_id: missionId,
        tone: (resolved('tone') as 'friendly' | 'formal' | 'urgent' | undefined) ?? 'friendly',
        language: resolved('language') || 'ja',
        max_items: Number(resolved('max_items')) || 20,
      });
      const outputPath = resolved('output_path');
      const report = {
        mission_id: result.mission_id,
        scanned: result.scanned,
        reminded: result.reminded.length,
        items: result.reminded,
        generated_at: result.generated_at,
      };
      if (outputPath) writeJSON(outputPath, report);
      return {
        handled: true,
        ctx: assign({
          ...(outputPath ? { written_to: outputPath } : {}),
          reminded_count: result.reminded.length,
          scanned_count: result.scanned,
        }),
      };
    }

    case 'audit_speaker_fairness': {
      const missionId = resolved('mission_id') || process.env.MISSION_ID || '';
      if (!missionId) {
        throw new Error('audit_speaker_fairness: mission_id is required');
      }
      const report = auditSpeakerFairnessOp({ mission_id: missionId });
      const outputPath = resolved('output_path');
      if (outputPath) writeJSON(outputPath, report);
      return {
        handled: true,
        ctx: assign({
          ...(outputPath ? { written_to: outputPath } : {}),
          speaker_fairness_warn: report.warn,
          dominant_speaker: report.dominant_speaker,
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

    case 'adjust_proposal': {
      const result = adjustProposalAppend({
        proposal_path: resolved('proposal') || resolved('proposal_path'),
        signals: params.new_signals || ctx[params.signals_from || 'new_signals'],
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'a2a_fanout': {
      const personasResolved = resolved('personas') || ctx[params.personas_from || 'personas'] || [];
      const minResolved = resolved('min_hypotheses_per_persona') || 2;
      const result = await a2aFanout({
        personas: Array.isArray(personasResolved) ? personasResolved : [],
        min_hypotheses_per_persona: Number(minResolved) || 2,
        topic: resolved('topic'),
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'cross_critique': {
      const personasResolved = resolved('personas') || ctx[params.personas_from || 'personas'] || [];
      const result = await crossCritique({
        source_path: resolved('input') || resolved('source_path'),
        personas: Array.isArray(personasResolved) ? personasResolved : [],
        output_path: resolved('output_path'),
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

    case 'a2a_roleplay': {
      const result = await a2aRoleplay({
        persona: params.persona || ctx[params.persona_from || 'persona_spec'],
        objective: resolved('objective'),
        time_budget_minutes: params.time_budget_minutes || 15,
        output_path: resolved('output_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'conduct_1on1': {
      const result = await conduct1on1({
        counterparty_ref: resolved('counterparty_ref'),
        proposal_draft_ref: resolved('proposal_draft_ref'),
        structure: params.structure || [],
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
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'capture_intuition': {
      const result = captureIntuition({
        decision: resolved('decision'),
        anchor: resolved('anchor'),
        analogy: resolved('analogy'),
        vetoed_options: params.vetoed_options || ctx[params.vetoed_options_from || 'vetoed_options'],
        mission_id: resolved('mission_id'),
        trigger: resolved('trigger') as CaptureIntuitionInput['trigger'],
        tags: params.tags || ctx[params.tags_from || 'tags'],
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'extract_requirements': {
      const result = await extractRequirementsOp({
        mission_id: resolved('mission_id'),
        project_name: resolved('project_name'),
        source_path: resolved('source_path') || resolved('transcript_path'),
        source_type: resolved('source_type') as ExtractRequirementsOpInput['source_type'],
        language: resolved('language'),
        customer_name: resolved('customer_name'),
        customer_person_slug: resolved('customer_person_slug'),
        customer_org: resolved('customer_org'),
        prior_draft_ref: resolved('prior_draft_ref'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'evaluate_requirements_completeness': {
      const result = evaluateRequirementsCompletenessGate(resolved('mission_id'));
      return { handled: true, ctx: assign(result) };
    }

    case 'evaluate_customer_signoff': {
      const result = evaluateCustomerSignoffGate(resolved('mission_id'));
      return { handled: true, ctx: assign(result) };
    }

    case 'extract_design_spec': {
      const result = await extractDesignSpecOp({
        mission_id: resolved('mission_id'),
        project_name: resolved('project_name'),
        requirements_draft_path: resolved('requirements_draft_path'),
        additional_context: resolved('additional_context'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'evaluate_architecture_ready': {
      const result = evaluateArchitectureReadyGate(resolved('mission_id'));
      return { handled: true, ctx: assign(result) };
    }

    case 'extract_test_plan': {
      const result = await extractTestPlanOp({
        mission_id: resolved('mission_id'),
        project_name: resolved('project_name'),
        app_id: resolved('app_id'),
        requirements_draft_path: resolved('requirements_draft_path'),
        design_spec_path: resolved('design_spec_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'evaluate_qa_ready': {
      const mustIds = Array.isArray(params.must_have_ids)
        ? params.must_have_ids
        : ctx[params.must_have_ids_from || 'must_have_ids'];
      const result = evaluateQaReadyGate(
        resolved('mission_id'),
        Array.isArray(mustIds) ? mustIds : [],
      );
      return { handled: true, ctx: assign(result) };
    }

    case 'decompose_into_tasks': {
      const result = await decomposeIntoTasksOp({
        mission_id: resolved('mission_id'),
        project_name: resolved('project_name'),
        requirements_draft_path: resolved('requirements_draft_path'),
        design_spec_path: resolved('design_spec_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'evaluate_task_plan_ready': {
      const result = evaluateTaskPlanReadyGate(resolved('mission_id'));
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

    case 'execute_task_plan': {
      const { executeTaskPlan } = await import('@agent/core');
      const result = await executeTaskPlan({
        missionId: resolved('mission_id'),
        model: resolved('model'),
        cwd: resolved('cwd'),
        maxTasks: typeof params.max_tasks === 'number' ? params.max_tasks : undefined,
        haltOnFailure: Boolean(params.halt_on_failure),
      });
      return { handled: true, ctx: assign(result) };
    }

    case 'deploy_release': {
      const { getDeploymentAdapter, requireApprovalForOp, RISKY_OPS } = await import('@agent/core');
      // Gate the deploy behind the config-policy-update approval rule.
      const missionId = resolved('mission_id');
      const environment = resolved('environment');
      const approval = requireApprovalForOp({
        opId: RISKY_OPS.CONFIG_UPDATE,
        agentId: 'mission_controller',
        correlationId: `${missionId}:deploy:${environment}`,
        channel: 'system',
        payload: {
          scope: 'governance',
          environment,
          version: resolved('version'),
          projectName: resolved('project_name'),
        },
        draft: {
          title: `Deploy ${resolved('project_name')}@${resolved('version')} → ${environment}`,
          summary: `Mission ${missionId} requests release deployment.`,
          severity: environment === 'prod' ? 'high' : 'medium',
        },
      });
      if (!approval.allowed) {
        return {
          handled: true,
          ctx: assign({
            status: 'blocked_by_approval',
            approval_status: approval.status,
            approval_request_id: approval.requestId,
            message: approval.message,
          }),
        };
      }
      const adapter = getDeploymentAdapter();
      const result = await adapter.deploy({
        environment,
        projectName: resolved('project_name'),
        version: resolved('version'),
        releaseNotesPath: resolved('release_notes_path'),
      });
      return { handled: true, ctx: assign(result) };
    }

    default:
      return { handled: false, ctx };
  }
}
