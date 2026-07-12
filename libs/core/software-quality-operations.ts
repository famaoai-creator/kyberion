import * as path from 'node:path';

import { getReasoningBackend } from './reasoning-backend.js';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile } from './secure-io.js';
import type {
  DefectCandidate,
  SoftwareQualityContract,
  SoftwareQualityReportSummary,
  TestExecutionResult,
  TestInventory,
  TestInventoryItem,
} from './software-quality.js';

export interface TestViewpointDefinition {
  viewpoint_id: string;
  category: string;
  title: string;
  prompts: string[];
  default_risk: 'low' | 'medium' | 'high' | 'critical';
  applicability_tags?: string[];
}

export interface TestViewpointCatalog {
  version: string;
  viewpoints: TestViewpointDefinition[];
}

export interface DeriveTestInventoryInput {
  contract: SoftwareQualityContract;
  systemTags: string[];
  riskRefs?: string[];
  additionalContext?: string;
  projectId?: string;
}

function loadViewpointCatalog(): TestViewpointCatalog {
  return JSON.parse(
    safeReadFile(pathResolver.knowledge('product/governance/software-test-viewpoints.json'), {
      encoding: 'utf8',
    }) as string
  ) as TestViewpointCatalog;
}

function deterministicInventory(input: DeriveTestInventoryInput): TestInventoryItem[] {
  const tags = new Set(input.systemTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  const catalog = loadViewpointCatalog();
  return catalog.viewpoints
    .filter((viewpoint) =>
      (viewpoint.applicability_tags ?? ['all']).some((tag) => tag === 'all' || tags.has(tag))
    )
    .map((viewpoint, index) => ({
      item_id: `AUTO-${String(index + 1).padStart(3, '0')}`,
      title: viewpoint.title,
      viewpoint_ids: [viewpoint.viewpoint_id],
      requirement_refs: input.contract.must_have_requirement_ids ?? [],
      acceptance_criteria_refs: input.contract.acceptance_criteria.map(
        (criterion) => criterion.criterion_id
      ),
      risk_refs: input.riskRefs ?? [],
      risk_level: viewpoint.default_risk,
      expected_result: viewpoint.prompts.join(' / '),
      execution_mode: viewpoint.default_risk === 'critical' ? 'approval_required' : 'safe_auto',
    }));
}

function parseReasoningItems(raw: string): TestInventoryItem[] {
  const match = raw.match(/\{[\s\S]*\}/u);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { items?: TestInventoryItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

export async function deriveTestInventory(input: DeriveTestInventoryInput): Promise<TestInventory> {
  const deterministic = deterministicInventory(input);
  const backend = getReasoningBackend();
  let additions: TestInventoryItem[] = [];
  if (backend.name !== 'stub') {
    const prompt = [
      'You are a software QA analyst. Add only missing test viewpoints; never remove supplied items.',
      'Return JSON only: {"items":[TestInventoryItem...]}.',
      `Contract: ${JSON.stringify(input.contract)}`,
      `System tags: ${input.systemTags.join(', ')}`,
      `Risk refs: ${(input.riskRefs ?? []).join(', ')}`,
      `Deterministic items: ${JSON.stringify(deterministic)}`,
      input.additionalContext ? `Context: ${input.additionalContext}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    additions = parseReasoningItems(await backend.prompt(prompt));
  }
  const seenViewpoints = new Set(deterministic.flatMap((item) => item.viewpoint_ids));
  const acceptedAdditions = additions.filter((item) => {
    if (!item.item_id || !item.title || !item.expected_result || item.viewpoint_ids?.length === 0) {
      return false;
    }
    if (item.viewpoint_ids.some((viewpoint) => seenViewpoints.has(viewpoint))) return false;
    item.viewpoint_ids.forEach((viewpoint) => seenViewpoints.add(viewpoint));
    return true;
  });
  return {
    version: '2.0.0',
    project_id: input.projectId ?? input.contract.project_id,
    items: [...deterministic, ...acceptedAdditions],
  };
}

export type TestDispatchStatus =
  | 'passed'
  | 'failed'
  | 'error'
  | 'awaiting_approval'
  | 'manual_required'
  | 'prohibited';

export interface TestDispatchResult {
  item_id: string;
  status: TestDispatchStatus;
  backend?: string;
  evidence_refs: string[];
  observed_result?: string;
  approval_request_id?: string;
}

export interface TestExecutorResult {
  status: 'passed' | 'failed' | 'error';
  evidence_refs: string[];
  observed_result?: string;
}

export type TestExecutor = (item: TestInventoryItem) => Promise<TestExecutorResult>;

export interface CompiledTestPipeline {
  action: 'pipeline';
  name: string;
  version: string;
  description: string;
  context: Record<string, unknown>;
  steps: Array<{
    id: string;
    role: 'transform';
    op: string;
    params: Record<string, unknown>;
  }>;
  deferred: Array<{
    item_id: string;
    execution_mode: TestInventoryItem['execution_mode'];
    reason: string;
  }>;
}

export function compileTestInventoryToAdf(input: {
  inventory: TestInventory;
  pipelineName?: string;
}): CompiledTestPipeline {
  const steps: CompiledTestPipeline['steps'] = [];
  const deferred: CompiledTestPipeline['deferred'] = [];
  for (const item of input.inventory.items) {
    if (item.execution_mode !== 'safe_auto') {
      deferred.push({
        item_id: item.item_id,
        execution_mode: item.execution_mode,
        reason: item.omission_reason ?? `Execution mode is ${item.execution_mode}.`,
      });
      continue;
    }
    if (!item.automation) {
      deferred.push({
        item_id: item.item_id,
        execution_mode: item.execution_mode,
        reason: 'No governed actuator automation is defined.',
      });
      continue;
    }
    steps.push({
      id: `qa_${item.item_id.toLowerCase().replace(/[^a-z0-9_]+/gu, '_')}`,
      role: 'transform',
      op: `${item.automation.actuator}:${item.automation.op}`,
      params: {
        ...item.automation.params,
        qa_item_id: item.item_id,
        expected_result: item.expected_result,
      },
    });
  }
  return {
    action: 'pipeline',
    name: input.pipelineName ?? `qa-execution-${input.inventory.project_id}`,
    version: '1.0.0',
    description: 'Compiled governed test execution pipeline. Only safe_auto items are executable.',
    context: { project_id: input.inventory.project_id },
    steps,
    deferred,
  };
}

function inferExecutor(item: TestInventoryItem): string {
  const viewpoint = item.viewpoint_ids.join(' ');
  if (/ux|accessibility|browser/u.test(viewpoint)) return 'browser';
  if (/contract|integration/u.test(viewpoint)) return 'network';
  if (/security/u.test(viewpoint)) return 'security';
  if (/operations|state|performance/u.test(viewpoint)) return 'system';
  return 'code';
}

export async function dispatchTestInventory(input: {
  inventory: TestInventory;
  executors: Partial<Record<'browser' | 'network' | 'security' | 'system' | 'code', TestExecutor>>;
  requestApproval?: (item: TestInventoryItem) => string;
}): Promise<TestDispatchResult[]> {
  const results: TestDispatchResult[] = [];
  for (const item of input.inventory.items) {
    if (item.execution_mode === 'prohibited') {
      results.push({ item_id: item.item_id, status: 'prohibited', evidence_refs: [] });
      continue;
    }
    if (item.execution_mode === 'manual_only') {
      results.push({ item_id: item.item_id, status: 'manual_required', evidence_refs: [] });
      continue;
    }
    if (item.execution_mode === 'approval_required') {
      results.push({
        item_id: item.item_id,
        status: 'awaiting_approval',
        evidence_refs: [],
        ...(input.requestApproval ? { approval_request_id: input.requestApproval(item) } : {}),
      });
      continue;
    }
    const backend = inferExecutor(item) as keyof typeof input.executors;
    const executor = input.executors[backend];
    if (!executor) {
      results.push({
        item_id: item.item_id,
        status: 'error',
        backend,
        evidence_refs: [],
        observed_result: `No ${backend} test executor is registered.`,
      });
      continue;
    }
    const result = await executor(item);
    results.push({ item_id: item.item_id, backend, ...result });
  }
  return results;
}

export type DefectStatus =
  | 'candidate'
  | 'open'
  | 'in_progress'
  | 'fixed'
  | 'retest'
  | 'closed'
  | 'reopened'
  | 'duplicate'
  | 'cannot_reproduce'
  | 'accepted_risk';

export interface DefectTransitionEvent {
  defect_id: string;
  from: DefectStatus | null;
  to: DefectStatus;
  actor_id: string;
  actor_type: 'human' | 'ai_agent' | 'automation';
  reason: string;
  evidence_refs: string[];
  occurred_at: string;
}

const DEFECT_TRANSITIONS: Record<DefectStatus, DefectStatus[]> = {
  candidate: ['open', 'duplicate', 'cannot_reproduce'],
  open: ['in_progress', 'duplicate', 'cannot_reproduce', 'accepted_risk'],
  in_progress: ['fixed', 'open'],
  fixed: ['retest', 'reopened'],
  retest: ['closed', 'reopened'],
  closed: ['reopened'],
  reopened: ['in_progress', 'accepted_risk'],
  duplicate: [],
  cannot_reproduce: ['reopened'],
  accepted_risk: ['reopened'],
};

function readDefectEvents(filePath: string): DefectTransitionEvent[] {
  if (!safeExistsSync(filePath)) return [];
  return (safeReadFile(filePath, { encoding: 'utf8' }) as string)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DefectTransitionEvent);
}

export function defectCurrentStatus(
  defectId: string,
  filePath = pathResolver.shared('runtime/qa/defect-events.jsonl')
): DefectStatus | null {
  const events = readDefectEvents(filePath).filter((event) => event.defect_id === defectId);
  return events.length > 0 ? events[events.length - 1].to : null;
}

export function recordDefectCandidate(
  defect: DefectCandidate,
  actorId: string,
  filePath = pathResolver.shared('runtime/qa/defect-events.jsonl')
): DefectTransitionEvent {
  if (defectCurrentStatus(defect.defect_id, filePath)) {
    throw new Error(`Defect already exists: ${defect.defect_id}`);
  }
  return appendDefectEvent(
    {
      defect_id: defect.defect_id,
      from: null,
      to: 'candidate',
      actor_id: actorId,
      actor_type: 'ai_agent',
      reason: defect.title,
      evidence_refs: defect.evidence_refs,
      occurred_at: new Date().toISOString(),
    },
    filePath
  );
}

function appendDefectEvent(event: DefectTransitionEvent, filePath: string): DefectTransitionEvent {
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeAppendFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
  return event;
}

export function transitionDefect(input: {
  defectId: string;
  to: DefectStatus;
  actorId: string;
  actorType: 'human' | 'ai_agent' | 'automation';
  reason: string;
  evidenceRefs?: string[];
  filePath?: string;
}): DefectTransitionEvent {
  const filePath = input.filePath ?? pathResolver.shared('runtime/qa/defect-events.jsonl');
  const from = defectCurrentStatus(input.defectId, filePath);
  if (!from) throw new Error(`Unknown defect: ${input.defectId}`);
  if (!DEFECT_TRANSITIONS[from].includes(input.to)) {
    throw new Error(`Invalid defect transition: ${from} -> ${input.to}`);
  }
  if (input.to === 'accepted_risk' && input.actorType !== 'human') {
    throw new Error('Only a human can accept residual defect risk.');
  }
  return appendDefectEvent(
    {
      defect_id: input.defectId,
      from,
      to: input.to,
      actor_id: input.actorId,
      actor_type: input.actorType,
      reason: input.reason,
      evidence_refs: input.evidenceRefs ?? [],
      occurred_at: new Date().toISOString(),
    },
    filePath
  );
}

export type QualityEnforcementMode = 'report-only' | 'warn' | 'enforce';

export function evaluateQualityEnforcement(input: {
  report: SoftwareQualityReportSummary;
  mode: QualityEnforcementMode;
}): { allowed: boolean; severity: 'info' | 'warning' | 'blocking'; reasons: string[] } {
  const acceptable = input.report.recommendation === 'go';
  if (input.mode === 'report-only') {
    return { allowed: true, severity: 'info', reasons: input.report.recommendation_reasons };
  }
  if (input.mode === 'warn') {
    return {
      allowed: true,
      severity: acceptable ? 'info' : 'warning',
      reasons: input.report.recommendation_reasons,
    };
  }
  return {
    allowed: acceptable,
    severity: acceptable ? 'info' : 'blocking',
    reasons: input.report.recommendation_reasons,
  };
}

export function toExecutionResults(results: TestDispatchResult[]): TestExecutionResult[] {
  return results.map((result) => ({
    item_id: result.item_id,
    status:
      result.status === 'awaiting_approval' ||
      result.status === 'manual_required' ||
      result.status === 'prohibited'
        ? 'blocked'
        : result.status,
    evidence_refs: result.evidence_refs,
    observed_result: result.observed_result,
  }));
}
