import AjvModule, { type ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { logger } from './core.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import { buildOrganizationWorkLoopSummary, type OrganizationWorkLoopSummary } from './work-design.js';

export type TaskSessionSurface = 'presence' | 'slack' | 'terminal' | 'chronos' | 'web';
export type TaskSessionType =
  | 'browser'
  | 'capture_photo'
  | 'workbook_wbs'
  | 'presentation_deck'
  | 'report_document'
  | 'service_operation'
  | 'document_generation'
  | 'analysis';
export type TaskSessionStatus =
  | 'awaiting_instruction'
  | 'collecting_requirements'
  | 'planning'
  | 'awaiting_confirmation'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'paused'
  | 'released';
export type TaskSessionMode = 'interactive' | 'delegated' | 'shadow';

export interface TaskSessionHistoryEntry {
  ts: string;
  type: 'instruction' | 'ack' | 'plan' | 'execution' | 'verification' | 'feedback' | 'error' | 'control' | 'artifact';
  text: string;
}

export interface TaskSession {
  session_id: string;
  surface: TaskSessionSurface;
  task_type: TaskSessionType;
  status: TaskSessionStatus;
  mode: TaskSessionMode;
  goal: {
    summary: string;
    success_condition: string;
  };
  project_context?: {
    project_id?: string;
    project_name?: string;
    track_id?: string;
    track_name?: string;
    tier?: 'personal' | 'confidential' | 'public';
    service_bindings?: string[];
    locale?: string;
  };
  work_loop?: OrganizationWorkLoopSummary;
  artifact?: {
    kind?: string;
    output_path?: string;
    preview_text?: string;
    [key: string]: unknown;
  };
  requirements?: {
    missing?: string[];
    collected?: Record<string, unknown>;
  };
  control: {
    interruptible: boolean;
    requires_approval: boolean;
    awaiting_user_input: boolean;
  };
  history: TaskSessionHistoryEntry[];
  updated_at: string;
  payload?: Record<string, unknown>;
}

export interface TaskSessionIntent {
  taskType: TaskSessionType;
  intentId?: string;
  goal: TaskSession['goal'];
  projectContext?: TaskSession['project_context'];
  requirements?: TaskSession['requirements'];
  payload?: TaskSession['payload'];
}

interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const TASK_SESSION_SCHEMA_PATH = pathResolver.knowledge('public/schemas/task-session.schema.json');
const TASK_SESSION_DIR = pathResolver.shared('runtime/task-sessions');

let taskSessionValidateFn: ValidateFunction | null = null;
let standardIntentCache: Array<{
  id?: string;
  trigger_keywords?: string[];
  resolution?: {
    shape?: string;
    task_kind?: string;
  };
}> | null = null;

function loadStandardIntentCatalog() {
  if (standardIntentCache) return standardIntentCache;
  const filePath = pathResolver.knowledge('public/governance/standard-intents.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as {
    intents?: Array<{
      id?: string;
      trigger_keywords?: string[];
      resolution?: {
        shape?: string;
        task_kind?: string;
      };
    }>;
  };
  standardIntentCache = Array.isArray(parsed.intents) ? parsed.intents : [];
  return standardIntentCache;
}

function matchesStandardIntent(utterance: string, intentId: string): boolean {
  const normalized = utterance.toLowerCase();
  const intent = loadStandardIntentCatalog().find((entry) => entry.id === intentId);
  const keywords = Array.isArray(intent?.trigger_keywords) ? intent!.trigger_keywords : [];
  return keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}

function isBootstrapProjectUtterance(utterance: string): boolean {
  if (!matchesStandardIntent(utterance, 'bootstrap-project')) return false;
  if (matchesStandardIntent(utterance, 'generate-workbook')) return false;
  if (matchesStandardIntent(utterance, 'generate-presentation')) return false;
  if (matchesStandardIntent(utterance, 'generate-report')) return false;
  if (matchesStandardIntent(utterance, 'inspect-service')) return false;
  return true;
}

function ensureTaskSessionValidator(): ValidateFunction {
  if (taskSessionValidateFn) return taskSessionValidateFn;
  taskSessionValidateFn = compileSchemaFromPath(ajv, TASK_SESSION_SCHEMA_PATH);
  return taskSessionValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
}

function taskSessionPath(sessionId: string): string {
  return `${TASK_SESSION_DIR}/${sessionId}.json`;
}

export function createTaskSession(input: {
  sessionId?: string;
  surface: TaskSessionSurface;
  taskType: TaskSessionType;
  status?: TaskSessionStatus;
  mode?: TaskSessionMode;
  requiresApproval?: boolean;
  goal: TaskSession['goal'];
  projectContext?: TaskSession['project_context'];
  intentId?: string;
  shape?: 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap';
  outcomeIds?: string[];
  requirements?: TaskSession['requirements'];
  payload?: TaskSession['payload'];
  workLoop?: OrganizationWorkLoopSummary;
}): TaskSession {
  const now = new Date().toISOString();
  const workLoop = input.workLoop || buildOrganizationWorkLoopSummary({
    intentId: input.intentId,
    taskType: input.taskType,
    shape: input.shape,
    outcomeIds: input.outcomeIds,
    projectId: input.projectContext?.project_id,
    projectName: input.projectContext?.project_name,
    trackId: input.projectContext?.track_id,
    trackName: input.projectContext?.track_name,
    tier: input.projectContext?.tier,
    locale: input.projectContext?.locale,
    serviceBindings: input.projectContext?.service_bindings,
    requiresApproval: input.requiresApproval,
  });
  return {
    session_id: input.sessionId || `TSK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: input.surface,
    task_type: input.taskType,
    status: input.status || 'awaiting_instruction',
    mode: input.mode || 'interactive',
    goal: input.goal,
    project_context: input.projectContext,
    work_loop: workLoop,
    requirements: input.requirements,
    control: {
      interruptible: true,
      requires_approval: Boolean(input.requiresApproval),
      awaiting_user_input: Boolean(input.requirements?.missing?.length),
    },
    history: [],
    updated_at: now,
    payload: input.payload,
  };
}

export function classifyTaskSessionIntent(utterance: string): TaskSessionIntent | null {
  const trimmed = utterance.trim();
  if (!trimmed) return null;

  if (isBootstrapProjectUtterance(trimmed)) {
    return {
      taskType: 'analysis',
      intentId: 'bootstrap-project',
      goal: {
        summary: 'Bootstrap a governed project context',
        success_condition: 'A project record, kickoff context, and first work items are prepared.',
      },
      requirements: {
        missing: ['project_brief'],
        collected: {},
      },
      payload: {
        bootstrap_kind: 'project_bootstrap',
      },
    };
  }

  if (/(写真|撮影|photo|picture|camera)/i.test(trimmed)) {
    return {
      taskType: 'capture_photo',
      intentId: 'capture-photo',
      goal: {
        summary: 'Capture a photo for the requested purpose',
        success_condition: 'A photo artifact is captured and stored in a governed path.',
      },
      requirements: {
        missing: /(記録用|共有用|reference|record|share|ocr)/i.test(trimmed) ? [] : ['camera_intent'],
        collected: {},
      },
      payload: {
        camera_intent: /ocr/i.test(trimmed)
          ? 'ocr_source'
          : /共有|share/i.test(trimmed)
            ? 'share'
            : /記録|record/i.test(trimmed)
              ? 'record'
              : 'record',
      },
    };
  }

  if (matchesStandardIntent(trimmed, 'generate-workbook') || /(wbs|work breakdown|エクセル|excel|xlsx|スプレッドシート)/i.test(trimmed)) {
    return {
      taskType: 'workbook_wbs',
      intentId: 'generate-workbook',
      goal: {
        summary: 'Create a WBS workbook from the project context',
        success_condition: 'An XLSX workbook draft is generated in a governed path.',
      },
      requirements: {
        missing: /(プロジェクト|project)/i.test(trimmed) ? [] : ['project_name'],
        collected: {},
      },
      payload: {
        granularity: /task/i.test(trimmed) ? 'task' : 'work_package',
      },
    };
  }

  if (matchesStandardIntent(trimmed, 'generate-presentation') || /(パワーポイント|powerpoint|pptx|deck|slide|スライド|提案資料|営業資料)/i.test(trimmed)) {
    return {
      taskType: 'presentation_deck',
      intentId: 'generate-presentation',
      goal: {
        summary: 'Create a presentation deck from available project context',
        success_condition: 'A PPTX draft is generated in a governed path.',
      },
      requirements: {
        missing: /(提案|proposal|営業|marketing|社内共有|briefing)/i.test(trimmed) ? [] : ['deck_purpose'],
        collected: {},
      },
      payload: {
        deck_purpose: /営業|marketing/i.test(trimmed)
          ? 'marketing'
          : /社内共有|briefing/i.test(trimmed)
            ? 'internal_share'
            : 'proposal',
        slide_count_hint: /(\d+)\s*(枚|slides?)/i.test(trimmed)
          ? Number(trimmed.match(/(\d+)\s*(枚|slides?)/i)?.[1] || 0)
          : undefined,
      },
    };
  }

  if (matchesStandardIntent(trimmed, 'generate-report') || /(レポート|報告書|summary|report|docx|pdf|文書)/i.test(trimmed)) {
    return {
      taskType: 'report_document',
      intentId: 'generate-report',
      goal: {
        summary: 'Create a document artifact for the requested audience',
        success_condition: 'A report document is generated in a governed path.',
      },
      requirements: {
        missing: /(進捗|status|要約|summary|proposal|仕様|spec)/i.test(trimmed) ? [] : ['report_kind'],
        collected: {},
      },
      payload: {
        report_kind: /仕様|spec/i.test(trimmed)
          ? 'spec'
          : /提案|proposal/i.test(trimmed)
            ? 'proposal'
            : /進捗|status/i.test(trimmed)
              ? 'status'
              : 'summary',
        format: /pdf/i.test(trimmed) ? 'pdf' : /markdown|md/i.test(trimmed) ? 'markdown' : 'docx',
      },
    };
  }

  if (matchesStandardIntent(trimmed, 'inspect-service') || /(再起動|restart|起動して|起動|stop|停止して|停止|status|状態|ログ|logs?)/i.test(trimmed)) {
    const operation = /再起動|restart/i.test(trimmed)
      ? 'restart'
      : /停止|stop/i.test(trimmed)
        ? 'stop'
        : /ログ|logs?/i.test(trimmed)
          ? 'logs'
          : /status|状態/i.test(trimmed)
            ? 'status'
            : 'start';
    const serviceMatch =
      trimmed.match(/([A-Za-z0-9._-]+)\s*(?:の|を)?\s*(再起動|restart|起動|停止|status|状態|ログ)/i) ||
      trimmed.match(/service\s+([A-Za-z0-9._-]+)/i);
    const requiresApproval = ['restart', 'start', 'stop'].includes(operation);
    return {
      taskType: 'service_operation',
      intentId: 'inspect-service',
      goal: {
        summary: 'Operate or inspect a managed service',
        success_condition: 'The requested service operation completes and the result is reported back.',
      },
      requirements: {
        missing: serviceMatch
          ? (requiresApproval ? ['approval_confirmation'] : [])
          : ['service_name'],
        collected: {},
      },
      payload: {
        service_name: serviceMatch?.[1],
        operation,
        approval_required: requiresApproval,
        log_tail_lines: /ログ|logs?/i.test(trimmed) ? 100 : undefined,
      },
    };
  }

  return null;
}

export function validateTaskSession(session: unknown): ValidationResult<TaskSession> {
  const validate = ensureTaskSessionValidator();
  const valid = validate(session);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (session as TaskSession) : undefined,
  };
}

export function saveTaskSession(session: TaskSession): string {
  const result = validateTaskSession(session);
  if (!result.valid) {
    throw new Error(`Invalid task session: ${result.errors.join('; ')}`);
  }
  if (!safeExistsSync(TASK_SESSION_DIR)) safeMkdir(TASK_SESSION_DIR, { recursive: true });
  const filePath = taskSessionPath(session.session_id);
  safeWriteFile(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

export function loadTaskSession(sessionId: string): TaskSession | null {
  const filePath = taskSessionPath(sessionId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as TaskSession;
  const result = validateTaskSession(parsed);
  if (!result.valid) {
    logger.warn(`[TASK_SESSION] Invalid session ${sessionId}: ${result.errors.join('; ')}`);
    return null;
  }
  return parsed;
}

export function listTaskSessions(surface?: TaskSessionSurface): TaskSession[] {
  if (!safeExistsSync(TASK_SESSION_DIR)) return [];
  return safeReaddir(TASK_SESSION_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadTaskSession(entry.replace(/\.json$/, '')))
    .filter((session): session is TaskSession => Boolean(session))
    .filter((session) => (surface ? session.surface === surface : true))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getActiveTaskSession(surface?: TaskSessionSurface): TaskSession | null {
  return listTaskSessions(surface).find((session) =>
    !['completed', 'failed', 'released'].includes(session.status),
  ) || null;
}

export function updateTaskSession(
  sessionId: string,
  patch: Partial<TaskSession>,
): TaskSession | null {
  const session = loadTaskSession(sessionId);
  if (!session) return null;
  const next: TaskSession = {
    ...session,
    ...patch,
    session_id: session.session_id,
    updated_at: new Date().toISOString(),
  };
  saveTaskSession(next);
  return next;
}

export function recordTaskSessionHistory(sessionId: string, entry: TaskSessionHistoryEntry): TaskSession | null {
  const session = loadTaskSession(sessionId);
  if (!session) return null;
  session.history = [...session.history, entry].slice(-50);
  session.updated_at = new Date().toISOString();
  saveTaskSession(session);
  return session;
}
