import AjvModule, { type ValidateFunction } from 'ajv';
import { CodexAppServerAdapter, ClaudeAdapter, GeminiAdapter } from './agent-adapter.js';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { classifyTaskSessionIntent } from './task-session.js';
import { buildOrganizationWorkLoopSummary, type OrganizationWorkLoopSummary } from './work-design.js';
import type { OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const INTENT_CONTRACT_SCHEMA_PATH = pathResolver.knowledge('public/schemas/intent-contract.schema.json');
const WORK_LOOP_SCHEMA_PATH = pathResolver.knowledge('public/schemas/organization-work-loop.schema.json');

type ExecutionShape = 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap';
export type IntentCompilerProvider = 'codex' | 'claude' | 'gemini';
export type IntentDeliveryMode = 'one_shot' | 'managed_program';

export interface IntentContract {
  kind: 'intent-contract';
  source_text: string;
  intent_id: string;
  goal: {
    summary: string;
    success_condition: string;
  };
  resolution: {
    execution_shape: ExecutionShape;
    task_type?: string;
  };
  required_inputs: string[];
  outcome_ids: string[];
  approval: {
    requires_approval: boolean;
  };
  delivery_mode: IntentDeliveryMode;
  clarification_needed: boolean;
  confidence: number;
  why: string;
}

export interface IntentDeliveryDecision {
  mode: IntentDeliveryMode;
  shouldBootstrapProject: boolean;
  shouldStartMission: boolean;
  shouldDeliverDirectOutcome: boolean;
  askHumanToConfirm: boolean;
  rationale: string;
}

export interface UserIntentFlow {
  intentContract: IntentContract;
  workLoop: OrganizationWorkLoopSummary;
  clarificationPacket?: OperatorInteractionPacket;
  source: 'llm' | 'fallback';
}

export interface CompileUserIntentFlowInput {
  text: string;
  channel?: string;
  locale?: string;
  projectId?: string;
  projectName?: string;
  trackId?: string;
  trackName?: string;
  tier?: 'personal' | 'confidential' | 'public';
  serviceBindings?: string[];
}

interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

interface LlmCompileOptions {
  askFn?: (prompt: string) => Promise<string>;
  provider?: IntentCompilerProvider;
  model?: string;
  modelProvider?: string;
}

export interface IntentCompilerTarget {
  provider: IntentCompilerProvider;
  model?: string;
  modelProvider?: string;
}

let intentContractValidateFn: ValidateFunction | null = null;
let workLoopValidateFn: ValidateFunction | null = null;

function ensureIntentContractValidator(): ValidateFunction {
  if (intentContractValidateFn) return intentContractValidateFn;
  intentContractValidateFn = compileSchemaFromPath(ajv, INTENT_CONTRACT_SCHEMA_PATH);
  return intentContractValidateFn;
}

function ensureWorkLoopValidator(): ValidateFunction {
  if (workLoopValidateFn) return workLoopValidateFn;
  workLoopValidateFn = compileSchemaFromPath(ajv, WORK_LOOP_SCHEMA_PATH);
  return workLoopValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
}

function validateIntentContract(value: unknown): ValidationResult<IntentContract> {
  const validate = ensureIntentContractValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (value as IntentContract) : undefined,
  };
}

function validateWorkLoop(value: unknown): ValidationResult<OrganizationWorkLoopSummary> {
  const validate = ensureWorkLoopValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (value as OrganizationWorkLoopSummary) : undefined,
  };
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function parseJsonObject<T>(text: string): T | null {
  const json = extractJsonObject(text.trim());
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function loadStandardIntents(): Array<{
  id?: string;
  description?: string;
  trigger_keywords?: string[];
  outcome_ids?: string[];
  specialist_id?: string;
  resolution?: { shape?: string; task_kind?: string; result_shape?: string };
  intake_requirements?: string[];
  plan_outline?: string[];
}> {
  const filePath = pathResolver.knowledge('public/governance/standard-intents.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as {
    intents?: Array<{
      id?: string;
      description?: string;
      trigger_keywords?: string[];
      outcome_ids?: string[];
      specialist_id?: string;
      resolution?: { shape?: string; task_kind?: string; result_shape?: string };
      intake_requirements?: string[];
      plan_outline?: string[];
    }>;
  };
  return Array.isArray(parsed.intents) ? parsed.intents : [];
}

function summarizeRelevantIntents(text: string): string {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const intents = loadStandardIntents();
  const scored = intents
    .map((intent) => {
      const keywords = Array.isArray(intent.trigger_keywords) ? intent.trigger_keywords : [];
      const score = keywords.reduce((acc, keyword) => {
        return acc + (tokens.some((token) => String(keyword).toLowerCase().includes(token) || token.includes(String(keyword).toLowerCase())) ? 1 : 0);
      }, 0);
      return { intent, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map(({ intent }) => ({
      id: intent.id,
      description: intent.description,
      resolution: intent.resolution,
      outcome_ids: intent.outcome_ids,
      intake_requirements: intent.intake_requirements,
      plan_outline: intent.plan_outline,
      specialist_id: intent.specialist_id,
      trigger_keywords: intent.trigger_keywords,
    }));

  return JSON.stringify(scored, null, 2);
}

function normalizeShape(shape?: string): ExecutionShape {
  if (shape === 'project_bootstrap' || shape === 'mission' || shape === 'direct_reply') return shape;
  return 'task_session';
}

function inferDeliveryMode(text: string, shape: ExecutionShape, requiredInputs: string[]): IntentDeliveryMode {
  if (shape === 'project_bootstrap' || shape === 'mission') return 'managed_program';
  if (/(継続|長期|運行管理|運用管理|project|プロジェクト|program|プログラム|track|トラック|ロードマップ|継続改善)/i.test(text)) {
    return 'managed_program';
  }
  if (requiredInputs.length >= 3 && /(定義書|基本設計|詳細設計|方針|計画)/i.test(text)) {
    return 'managed_program';
  }
  return 'one_shot';
}

function buildFallbackIntentContract(input: CompileUserIntentFlowInput): IntentContract {
  const classified = classifyTaskSessionIntent(input.text);
  if (classified) {
    const shape = classified.payload?.bootstrap_kind === 'project_bootstrap' ? 'project_bootstrap' : 'task_session';
    return {
      kind: 'intent-contract',
      source_text: input.text,
      intent_id: classified.intentId || classified.taskType,
      goal: classified.goal,
      resolution: {
        execution_shape: normalizeShape(shape),
        task_type: classified.taskType,
      },
      required_inputs: classified.requirements?.missing || [],
      outcome_ids: [],
      approval: {
        requires_approval: Boolean(classified.payload?.approval_required),
      },
      delivery_mode: shape === 'project_bootstrap' ? 'managed_program' : inferDeliveryMode(input.text, normalizeShape(shape), classified.requirements?.missing || []),
      clarification_needed: Boolean(classified.requirements?.missing?.length),
      confidence: 0.55,
      why: 'Fallback classifier mapped the request to the nearest governed task session contract.',
    };
  }

  return {
    kind: 'intent-contract',
    source_text: input.text,
    intent_id: 'general_request',
    goal: {
      summary: 'Clarify and respond to the current request',
      success_condition: 'The request is either clarified or answered without violating governance constraints.',
    },
    resolution: {
      execution_shape: 'direct_reply',
    },
    required_inputs: ['goal_or_target'],
    outcome_ids: [],
    approval: {
      requires_approval: false,
    },
    delivery_mode: inferDeliveryMode(input.text, 'direct_reply', ['goal_or_target']),
    clarification_needed: true,
    confidence: 0.25,
    why: 'Fallback could not derive a safe execution contract from the current request.',
  };
}

function buildIntentContractPrompt(input: CompileUserIntentFlowInput): string {
  return [
    'You are the Kyberion Intent Contract Compiler.',
    'Convert the user request into a governed JSON contract.',
    'Return JSON only. No markdown. No prose.',
    '',
    'Rules:',
    '- Choose execution_shape from: direct_reply, task_session, mission, project_bootstrap.',
    '- Use task_session for browser or document work instead of inventing new shapes.',
    '- Choose delivery_mode=managed_program when the request implies long-running operation, recurring revisions, project/track/mission management, or multiple staged outcomes.',
    '- Choose delivery_mode=one_shot when a direct deliverable can be produced without durable project governance.',
    '- Set clarification_needed=true when required_inputs is non-empty.',
    '- Keep outcome_ids aligned to governed catalog when possible.',
    '- Do not invent low-level actuator steps.',
    '',
    'Output schema:',
    JSON.stringify({
      kind: 'intent-contract',
      source_text: 'string',
      intent_id: 'string',
      goal: { summary: 'string', success_condition: 'string' },
      resolution: { execution_shape: 'direct_reply|task_session|mission|project_bootstrap', task_type: 'string?' },
      required_inputs: ['string'],
      outcome_ids: ['string'],
      approval: { requires_approval: true },
      delivery_mode: 'one_shot|managed_program',
      clarification_needed: true,
      confidence: 0.0,
      why: 'string',
    }, null, 2),
    '',
    'Relevant governed intents:',
    summarizeRelevantIntents(input.text),
    '',
    'Request context:',
    JSON.stringify({
      text: input.text,
      channel: input.channel,
      locale: input.locale,
      project_id: input.projectId,
      project_name: input.projectName,
      track_id: input.trackId,
      track_name: input.trackName,
      tier: input.tier || 'confidential',
      service_bindings: input.serviceBindings || [],
    }, null, 2),
  ].join('\n');
}

function buildWorkLoopPrompt(input: CompileUserIntentFlowInput, contract: IntentContract): string {
  return [
    'You are the Kyberion Work Loop Compiler.',
    'Produce a governed Organization Work Loop Summary JSON.',
    'Return JSON only. No markdown. No prose.',
    '',
    'Rules:',
    '- Preserve the intent contract execution shape.',
    '- Use the contract required_inputs as intake requirements when they are still needed.',
    '- Do not invent unauthorized execution capabilities.',
    '- Keep team_roles and specialist routing aligned to governed intent metadata when possible.',
    '',
    'Intent contract:',
    JSON.stringify(contract, null, 2),
    '',
    'Relevant governed intents:',
    summarizeRelevantIntents(input.text),
    '',
    'Output must match this structure:',
    'organization-work-loop.schema.json',
  ].join('\n');
}

async function defaultAsk(prompt: string, target = resolveIntentCompilerTarget()): Promise<string> {
  const provider = target.provider;
  if (provider === 'claude') {
    const adapter = new ClaudeAdapter({
      cwd: pathResolver.rootDir(),
      permissionMode: 'auto',
      systemPrompt: 'Return only valid JSON. Do not include markdown fences.',
      model: target.model,
    });
    await adapter.boot();
    try {
      const response = await adapter.ask(prompt);
      return response.text;
    } finally {
      await adapter.shutdown();
    }
  }

  if (provider === 'gemini') {
    const adapter = new GeminiAdapter({
      model: target.model,
    });
    await adapter.boot();
    try {
      const response = await adapter.ask(prompt);
      return response.text;
    } finally {
      await adapter.shutdown();
    }
  }

  const adapter = new CodexAppServerAdapter({
    cwd: pathResolver.rootDir(),
    systemPrompt: 'Return only valid JSON. Do not include markdown fences.',
    model: target.model,
    modelProvider: target.modelProvider,
    approvalMode: (process.env.KYBERION_CODEX_APPROVAL || 'strict').toLowerCase() === 'relaxed' ? 'relaxed' : 'strict',
  });
  await adapter.boot();
  try {
    const response = await adapter.ask(prompt);
    return response.text;
  } finally {
    await adapter.shutdown();
  }
}

export function resolveIntentCompilerTarget(options: Pick<LlmCompileOptions, 'provider' | 'model' | 'modelProvider'> = {}): IntentCompilerTarget {
  const rawProvider = (options.provider || process.env.KYBERION_INTENT_COMPILER_PROVIDER || 'codex').toLowerCase();
  const provider: IntentCompilerProvider = rawProvider === 'claude' || rawProvider === 'gemini' ? rawProvider : 'codex';
  const explicitModel = options.model || process.env.KYBERION_INTENT_COMPILER_MODEL;
  const explicitModelProvider = options.modelProvider || process.env.KYBERION_INTENT_COMPILER_MODEL_PROVIDER;

  if (provider === 'claude') {
    return {
      provider,
      model: explicitModel || process.env.KYBERION_CLAUDE_MODEL,
    };
  }

  if (provider === 'gemini') {
    return {
      provider,
      model: explicitModel || process.env.KYBERION_GEMINI_MODEL || 'gemini-2.5-flash',
    };
  }

  return {
    provider: 'codex',
    model: explicitModel || process.env.KYBERION_CODEX_MODEL,
    modelProvider: explicitModelProvider || process.env.KYBERION_CODEX_MODEL_PROVIDER,
  };
}

async function compileIntentContractWithLlm(
  input: CompileUserIntentFlowInput,
  options: LlmCompileOptions = {},
): Promise<IntentContract | null> {
  const ask = options.askFn || ((prompt: string) => defaultAsk(prompt, resolveIntentCompilerTarget(options)));
  const raw = await ask(buildIntentContractPrompt(input));
  const parsed = parseJsonObject<IntentContract>(raw);
  if (!parsed) return null;
  const result = validateIntentContract(parsed);
  return result.valid ? result.value! : null;
}

async function compileWorkLoopWithLlm(
  input: CompileUserIntentFlowInput,
  contract: IntentContract,
  options: LlmCompileOptions = {},
): Promise<OrganizationWorkLoopSummary | null> {
  const ask = options.askFn || ((prompt: string) => defaultAsk(prompt, resolveIntentCompilerTarget(options)));
  const raw = await ask(buildWorkLoopPrompt(input, contract));
  const parsed = parseJsonObject<OrganizationWorkLoopSummary>(raw);
  if (!parsed) return null;
  const result = validateWorkLoop(parsed);
  return result.valid ? result.value! : null;
}

function buildFallbackWorkLoop(input: CompileUserIntentFlowInput, contract: IntentContract): OrganizationWorkLoopSummary {
  return buildOrganizationWorkLoopSummary({
    intentId: contract.intent_id,
    taskType: contract.resolution.task_type,
    shape: contract.resolution.execution_shape,
    outcomeIds: contract.outcome_ids,
    tier: input.tier,
    projectId: input.projectId,
    projectName: input.projectName,
    trackId: input.trackId,
    trackName: input.trackName,
    locale: input.locale,
    serviceBindings: input.serviceBindings,
    requiresApproval: contract.approval.requires_approval,
  });
}

function buildClarificationPacket(contract: IntentContract, workLoop: OrganizationWorkLoopSummary): OperatorInteractionPacket | undefined {
  if (!contract.clarification_needed) return undefined;
  return {
    kind: 'operator-interaction-packet',
    interaction_type: 'clarification',
    headline: 'More context is required before execution',
    summary: contract.goal.summary,
    confidence: contract.confidence,
    questions: contract.required_inputs.map((item) => ({
      id: item,
      question: `Please provide ${item.replace(/_/g, ' ')}.`,
      reason: 'The request cannot be executed safely without this input.',
    })),
    suggested_response_style: 'clarify-first',
    llm_touchpoints: [
      {
        stage: 'intent_contract',
        purpose: 'Resolve the request into a governed execution contract',
        output_contract: 'intent-contract',
      },
      {
        stage: 'work_loop',
        purpose: 'Produce the governed execution and planning context',
        output_contract: 'organization-work-loop',
      },
    ],
    next_actions: [
      {
        id: 'provide_missing_inputs',
        action: 'Provide the missing inputs and recompile the execution contract.',
        next_action_type: 'clarify',
        priority: 'now',
      },
    ],
    readiness: workLoop.resolution.execution_shape,
  };
}

export function formatClarificationPacket(packet: OperatorInteractionPacket): string {
  const lines = [
    packet.headline,
    packet.summary,
    '',
    'Required inputs:',
  ];
  for (const question of packet.questions || []) {
    lines.push(`- ${question.id}: ${question.question}`);
  }
  return lines.join('\n');
}

export function deriveIntentDeliveryDecision(contract: IntentContract): IntentDeliveryDecision {
  const durableShape = contract.resolution.execution_shape === 'project_bootstrap' || contract.resolution.execution_shape === 'mission';
  const managedProgram = contract.delivery_mode === 'managed_program';
  const askHumanToConfirm = managedProgram && contract.resolution.execution_shape === 'task_session' && !contract.clarification_needed;

  return {
    mode: contract.delivery_mode,
    shouldBootstrapProject: contract.resolution.execution_shape === 'project_bootstrap' || askHumanToConfirm,
    shouldStartMission: contract.resolution.execution_shape === 'mission' || managedProgram,
    shouldDeliverDirectOutcome: contract.delivery_mode === 'one_shot' && !durableShape,
    askHumanToConfirm,
    rationale: managedProgram
      ? 'The request appears to require durable governance across revisions, work items, or staged outcomes.'
      : 'The request appears satisfiable as a single direct outcome without durable project scaffolding.',
  };
}

export async function compileUserIntentFlow(
  input: CompileUserIntentFlowInput,
  options: LlmCompileOptions = {},
): Promise<UserIntentFlow> {
  let intentContract: IntentContract | null = null;
  let workLoop: OrganizationWorkLoopSummary | null = null;
  let source: 'llm' | 'fallback' = 'llm';

  try {
    intentContract = await compileIntentContractWithLlm(input, options);
    if (intentContract) {
      workLoop = await compileWorkLoopWithLlm(input, intentContract, options);
    }
  } catch (error: any) {
    logger.warn(`[INTENT_CONTRACT] LLM compilation failed: ${error?.message || String(error)}`);
  }

  if (!intentContract) {
    source = 'fallback';
    intentContract = buildFallbackIntentContract(input);
  }
  if (!workLoop) {
    source = 'fallback';
    workLoop = buildFallbackWorkLoop(input, intentContract);
  }

  return {
    intentContract,
    workLoop,
    clarificationPacket: buildClarificationPacket(intentContract, workLoop),
    source,
  };
}
