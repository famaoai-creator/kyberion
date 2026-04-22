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
}): Promise<{ written_to: string }> {
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
  const outPath = `${input.output_dir.replace(/\/$/, '')}/simulation-summary.json`;
  writeJSON(outPath, summary);
  return { written_to: outPath };
}

// ---------------------------------------------------------------------------
// Dispatcher — routes wisdom: decision ops from the pipeline engine.
// Returns ctx augmented with op output if export_as is provided.
// ---------------------------------------------------------------------------

export async function dispatchDecisionOp(
  op: string,
  params: any,
  ctx: Ctx,
): Promise<{ handled: boolean; ctx: Ctx }> {
  const resolved = (k: string) => resolveVars(params[k], ctx);
  const exportAs = params.export_as;
  const assign = (value: any): Ctx => (exportAs ? { ...ctx, [exportAs]: value } : ctx);

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
