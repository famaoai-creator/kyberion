import AjvModule, { type ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExec, safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import { resolveSurfaceIntent } from './router-contract.js';

export type BrowserConversationSurface = 'presence' | 'slack' | 'terminal' | 'chronos' | 'web';
export type BrowserConversationStatus =
  | 'idle'
  | 'observing'
  | 'awaiting_instruction'
  | 'resolving_target'
  | 'awaiting_confirmation'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'paused'
  | 'released';
export type BrowserConversationMode = 'interactive' | 'delegated' | 'shadow';
export type BrowserConversationCommandType = 'task_command' | 'step_command' | 'control_command';

export interface BrowserConversationCommandResolution {
  commandType: BrowserConversationCommandType;
  action?: BrowserConversationCommand['resolution']['action'];
  inputText?: string;
  targetHint?: BrowserConversationCommand['resolution']['target_hint'];
}

export interface BrowserConversationCandidateBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BrowserConversationCandidateTarget {
  element_id: string;
  role?: string;
  label?: string;
  text?: string;
  region_hint?: string;
  confidence: number;
  bounds?: BrowserConversationCandidateBounds;
}

export interface BrowserConversationHistoryEntry {
  ts: string;
  type: 'instruction' | 'ack' | 'observation' | 'execution' | 'verification' | 'feedback' | 'error' | 'control';
  text: string;
}

export interface BrowserConversationSession {
  session_id: string;
  surface: BrowserConversationSurface;
  status: BrowserConversationStatus;
  mode: BrowserConversationMode;
  target?: {
    app?: string;
    window_title?: string;
    url?: string;
    tab_id?: string;
    browser_session_id?: string;
  };
  goal: {
    summary: string;
    success_condition: string;
  };
  active_step?: {
    step_id: string;
    kind: 'observe' | 'click' | 'fill' | 'press' | 'scroll' | 'select' | 'extract' | 'confirm' | 'navigate' | 'wait';
    description: string;
    status: 'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';
  };
  observation?: {
    captured_at?: string;
    source?: 'dom' | 'vision' | 'dom+vision' | 'browser_runtime' | 'desktop';
    page_summary?: string;
    focused_element_id?: string;
  };
  candidate_targets: BrowserConversationCandidateTarget[];
  conversation_context: {
    last_user_instruction?: string;
    last_agent_ack?: string;
    pending_confirmation: boolean;
  };
  control: {
    interruptible: boolean;
    requires_approval: boolean;
    awaiting_user_input: boolean;
  };
  history: BrowserConversationHistoryEntry[];
  updated_at: string;
}

export interface BrowserConversationCommand {
  kind: 'browser_session_command';
  session_id: string;
  command_type: BrowserConversationCommandType;
  utterance: string;
  issued_at: string;
  resolution?: {
    action?: 'click' | 'fill' | 'press' | 'scroll' | 'observe' | 'navigate' | 'confirm' | 'cancel' | 'resume' | 'pause';
    input_text?: string;
    target_hint?: {
      text?: string;
      region?: string;
      role?: string;
      element_id?: string;
    };
  };
}

export interface BrowserConversationFeedback {
  kind: 'browser_session_feedback';
  session_id: string;
  status: 'progress' | 'awaiting_confirmation' | 'completed' | 'blocked' | 'failed';
  message: string;
  ts: string;
  candidates?: Array<{
    element_id: string;
    label?: string;
    region_hint?: string;
    confidence?: number;
  }>;
}

export interface BrowserConversationExecutionResult {
  ok: boolean;
  feedback: BrowserConversationFeedback;
  raw?: Record<string, unknown>;
}

function resolveConfirmationCandidateIndex(
  utterance: string,
  candidateCount: number,
): number | null {
  const trimmed = utterance.trim();
  if (!trimmed || candidateCount <= 0) return null;

  if (/^(それ|はい|yes|ok|そのまま|それで|お願いします)$/i.test(trimmed)) {
    return 0;
  }
  if (/^(最初|1つ目|一つ目|1番目|一番目|first)$/i.test(trimmed)) {
    return 0;
  }
  if (/^(2つ目|二つ目|2番目|二番目|second)$/i.test(trimmed) && candidateCount >= 2) {
    return 1;
  }
  if (/^(3つ目|三つ目|3番目|三番目|third)$/i.test(trimmed) && candidateCount >= 3) {
    return 2;
  }

  const directNumber = trimmed.match(/^([1-9][0-9]*)$/);
  if (directNumber) {
    const idx = Number(directNumber[1]) - 1;
    return idx >= 0 && idx < candidateCount ? idx : null;
  }

  return null;
}

interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

const SESSION_SCHEMA_PATH = pathResolver.knowledge('public/schemas/browser-conversation-session.schema.json');
const COMMAND_SCHEMA_PATH = pathResolver.knowledge('public/schemas/browser-conversation-command.schema.json');
const FEEDBACK_SCHEMA_PATH = pathResolver.knowledge('public/schemas/browser-conversation-feedback.schema.json');
const SESSION_DIR = pathResolver.shared('runtime/browser/conversation-sessions');
const BROWSER_SESSION_DIR = pathResolver.shared('runtime/browser/sessions');
const BROWSER_SNAPSHOT_DIR = pathResolver.shared('runtime/browser/snapshots');

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

let sessionValidateFn: ValidateFunction | null = null;
let commandValidateFn: ValidateFunction | null = null;
let feedbackValidateFn: ValidateFunction | null = null;

function loadSchemaValidator(schemaPath: string): ValidateFunction {
  const raw = safeReadFile(schemaPath, { encoding: 'utf8' }) as string;
  return ajv.compile(JSON.parse(raw));
}

function ensureSessionValidator(): ValidateFunction {
  sessionValidateFn ||= loadSchemaValidator(SESSION_SCHEMA_PATH);
  return sessionValidateFn;
}

function ensureCommandValidator(): ValidateFunction {
  commandValidateFn ||= loadSchemaValidator(COMMAND_SCHEMA_PATH);
  return commandValidateFn;
}

function ensureFeedbackValidator(): ValidateFunction {
  feedbackValidateFn ||= loadSchemaValidator(FEEDBACK_SCHEMA_PATH);
  return feedbackValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
}

function sessionPath(sessionId: string): string {
  return `${SESSION_DIR}/${sessionId}.json`;
}

function browserSnapshotPath(sessionId: string): string {
  return `${BROWSER_SNAPSHOT_DIR}/${sessionId}.json`;
}

function browserRuntimeSessionPath(sessionId: string): string {
  return `${BROWSER_SESSION_DIR}/${sessionId}.json`;
}

interface BrowserSnapshotElementRecord {
  ref: string;
  role?: string | null;
  text?: string;
  name?: string;
}

interface BrowserSnapshotRecord {
  session_id: string;
  tab_id: string;
  url: string;
  title: string;
  captured_at: string;
  element_count?: number;
  elements: BrowserSnapshotElementRecord[];
}

interface BrowserRuntimeSessionRecord {
  session_id: string;
  active_tab_id?: string;
  lease_status?: string;
  cdp_url?: string;
  cdp_port?: number;
  tabs?: Array<{
    tab_id: string;
    url?: string;
    title?: string;
    active?: boolean;
  }>;
}

function loadBrowserSnapshot(sessionId: string): BrowserSnapshotRecord | null {
  const filePath = browserSnapshotPath(sessionId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  return JSON.parse(raw) as BrowserSnapshotRecord;
}

function loadBrowserSnapshotForConversationSession(sessionId: string): BrowserSnapshotRecord | null {
  const directSnapshot = loadBrowserSnapshot(sessionId);
  if (directSnapshot) return directSnapshot;

  const session = loadBrowserConversationSession(sessionId);
  const browserSessionId = session?.target?.browser_session_id;
  if (!browserSessionId) return null;

  return loadBrowserSnapshot(browserSessionId);
}

function refreshBrowserSnapshotForConversationSession(session: BrowserConversationSession): BrowserSnapshotRecord | null {
  const browserSessionId = session.target?.browser_session_id;
  if (!browserSessionId) return null;

  const browserRuntimeSession = loadBrowserRuntimeSession(browserSessionId);
  const tmpPath = pathResolver.sharedTmp(`browser-conversation/refresh-${session.session_id}-${Date.now().toString(36)}.json`);
  const steps: Array<Record<string, unknown>> = [];
  if (session.target?.tab_id) {
    steps.push({
      type: 'control',
      op: 'select_tab',
      params: {
        tab_id: session.target.tab_id,
      },
    });
  }
  steps.push({
    type: 'capture',
    op: 'snapshot',
    params: {
      export_as: 'last_snapshot',
      max_elements: 200,
    },
  });
  safeWriteFile(tmpPath, JSON.stringify({
    action: 'pipeline',
    session_id: browserSessionId,
    options: {
      headless: false,
      keep_alive: false,
      connect_over_cdp: Boolean(browserRuntimeSession?.cdp_url),
      cdp_url: browserRuntimeSession?.cdp_url,
      cdp_port: browserRuntimeSession?.cdp_port,
    },
    steps,
  }, null, 2));

  try {
    safeExec('node', [
      'dist/libs/actuators/browser-actuator/src/index.js',
      '--input',
      tmpPath,
    ], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 60_000,
    });
  } catch {
    return loadBrowserSnapshot(browserSessionId);
  }

  return loadBrowserSnapshot(browserSessionId);
}

function loadBrowserRuntimeSession(sessionId: string): BrowserRuntimeSessionRecord | null {
  const filePath = browserRuntimeSessionPath(sessionId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  return JSON.parse(raw) as BrowserRuntimeSessionRecord;
}

function normalizeRegionHint(text?: string): string | undefined {
  if (!text) return undefined;
  if (/left/i.test(text) && /bottom/i.test(text)) return 'bottom-left';
  if (/right/i.test(text) && /bottom/i.test(text)) return 'bottom-right';
  if (/left/i.test(text) && /top/i.test(text)) return 'top-left';
  if (/right/i.test(text) && /top/i.test(text)) return 'top-right';
  if (/center|middle/i.test(text)) return 'center';
  return text;
}

function resolveCandidateTargets(
  sessionId: string,
  resolution?: BrowserConversationCommandResolution,
): BrowserConversationCandidateTarget[] {
  const session = loadBrowserConversationSession(sessionId);
  let snapshot = loadBrowserSnapshotForConversationSession(sessionId);
  if (session && (!snapshot || snapshot.element_count === 0 || (session.target?.tab_id && snapshot.tab_id !== session.target.tab_id))) {
    snapshot = refreshBrowserSnapshotForConversationSession(session);
  }
  if (!snapshot) return [];

  const hintText = (resolution?.targetHint?.text || '').trim().toLowerCase();
  const hintRole = (resolution?.targetHint?.role || '').trim().toLowerCase();
  const hintRegion = normalizeRegionHint(resolution?.targetHint?.region);

  return snapshot.elements
    .map((element) => {
      const label = (element.name || element.text || '').trim();
      const haystack = `${label} ${element.text || ''}`.toLowerCase();
      let score = 0;
      const textMatched = hintText ? haystack.includes(hintText) : false;
      if (textMatched) score += 0.65;
      if (hintRole && String(element.role || '').toLowerCase() === hintRole) score += 0.2;
      if (!hintText && label) score += 0.1;
      if (hintRegion) score += 0.05;
      if (hintText && !textMatched) score = 0;
      return {
        element_id: element.ref,
        role: element.role || undefined,
        label: label || undefined,
        text: element.text || undefined,
        region_hint: hintRegion,
        confidence: Math.min(1, Number(score.toFixed(2))),
      };
    })
    .filter((candidate) => candidate.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}

export function createBrowserConversationSession(input: {
  sessionId?: string;
  surface: BrowserConversationSurface;
  mode?: BrowserConversationMode;
  goal: { summary: string; success_condition: string };
  target?: BrowserConversationSession['target'];
}): BrowserConversationSession {
  const now = new Date().toISOString();
  return {
    session_id: input.sessionId || `BRS-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: input.surface,
    status: 'awaiting_instruction',
    mode: input.mode || 'interactive',
    target: input.target,
    goal: input.goal,
    candidate_targets: [],
    conversation_context: {
      pending_confirmation: false,
    },
    control: {
      interruptible: true,
      requires_approval: false,
      awaiting_user_input: false,
    },
    history: [],
    updated_at: now,
  };
}

export function bootstrapBrowserConversationSession(params: {
  browserSessionId: string;
  surface?: BrowserConversationSurface;
  conversationSessionId?: string;
  goalSummary?: string;
  successCondition?: string;
}): BrowserConversationSession {
  const browserSession = loadBrowserRuntimeSession(params.browserSessionId);
  if (!browserSession) {
    throw new Error(`Browser runtime session not found: ${params.browserSessionId}`);
  }

  if (!loadBrowserSnapshot(params.browserSessionId)) {
    const tmpPath = pathResolver.sharedTmp(`browser-conversation/bootstrap-${params.browserSessionId}.json`);
    safeWriteFile(tmpPath, JSON.stringify({
      action: 'pipeline',
      session_id: params.browserSessionId,
      options: {
        headless: false,
        keep_alive: true,
        lease_ms: 5 * 60 * 1000,
      },
      steps: [
        {
          type: 'capture',
          op: 'snapshot',
          params: {
            export_as: 'last_snapshot',
            max_elements: 200,
          },
        },
      ],
    }, null, 2));
    safeExec('node', [
      'dist/libs/actuators/browser-actuator/src/index.js',
      '--input',
      tmpPath,
    ], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 60_000,
    });
  }

  const activeTab = (browserSession.tabs || []).find((tab) => tab.active) || browserSession.tabs?.[0];
  const session = createBrowserConversationSession({
    sessionId: params.conversationSessionId || `BCS-${params.surface || 'presence'}-${params.browserSessionId}`,
    surface: params.surface || 'presence',
    goal: {
      summary: params.goalSummary || activeTab?.title || activeTab?.url || `Operate browser session ${params.browserSessionId}`,
      success_condition: params.successCondition || 'Complete the requested browser step safely.',
    },
    target: {
      app: 'browser',
      window_title: activeTab?.title,
      url: activeTab?.url,
      tab_id: browserSession.active_tab_id || activeTab?.tab_id,
      browser_session_id: params.browserSessionId,
    },
  });
  saveBrowserConversationSession(session);
  return session;
}

export function validateBrowserConversationSession(session: unknown): ValidationResult<BrowserConversationSession> {
  const validate = ensureSessionValidator();
  const valid = validate(session);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (session as BrowserConversationSession) : undefined,
  };
}

export function validateBrowserConversationCommand(command: unknown): ValidationResult<BrowserConversationCommand> {
  const validate = ensureCommandValidator();
  const valid = validate(command);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (command as BrowserConversationCommand) : undefined,
  };
}

export function validateBrowserConversationFeedback(feedback: unknown): ValidationResult<BrowserConversationFeedback> {
  const validate = ensureFeedbackValidator();
  const valid = validate(feedback);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (feedback as BrowserConversationFeedback) : undefined,
  };
}

export function saveBrowserConversationSession(session: BrowserConversationSession): string {
  const result = validateBrowserConversationSession(session);
  if (!result.valid) {
    throw new Error(`Invalid browser conversation session: ${result.errors.join('; ')}`);
  }
  if (!safeExistsSync(SESSION_DIR)) safeMkdir(SESSION_DIR, { recursive: true });
  const filePath = sessionPath(session.session_id);
  safeWriteFile(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

export function loadBrowserConversationSession(sessionId: string): BrowserConversationSession | null {
  const filePath = sessionPath(sessionId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as BrowserConversationSession;
  const result = validateBrowserConversationSession(parsed);
  if (!result.valid) {
    logger.warn(`[BROWSER_CONVERSATION_SESSION] Invalid session ${sessionId}: ${result.errors.join('; ')}`);
    return null;
  }
  return parsed;
}

export function listBrowserConversationSessions(): BrowserConversationSession[] {
  if (!safeExistsSync(SESSION_DIR)) return [];
  return safeReaddir(SESSION_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadBrowserConversationSession(entry.replace(/\.json$/, '')))
    .filter((session): session is BrowserConversationSession => Boolean(session))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function recordBrowserConversationHistory(
  sessionId: string,
  entry: BrowserConversationHistoryEntry,
): BrowserConversationSession | null {
  const session = loadBrowserConversationSession(sessionId);
  if (!session) return null;
  session.history = [...session.history, entry].slice(-50);
  session.updated_at = new Date().toISOString();
  saveBrowserConversationSession(session);
  return session;
}

export function getActiveBrowserConversationSession(surface?: BrowserConversationSurface): BrowserConversationSession | null {
  const sessions = listBrowserConversationSessions().filter((session) =>
    session.status !== 'completed' &&
    session.status !== 'failed' &&
    session.status !== 'released' &&
    session.status !== 'idle',
  );
  if (surface) {
    return sessions.find((session) => session.surface === surface) || null;
  }
  return sessions[0] || null;
}

export function classifyBrowserConversationCommand(utterance: string): BrowserConversationCommandResolution | null {
  const trimmed = utterance.trim();
  if (!trimmed) return null;
  const resolvedSurfaceIntent = resolveSurfaceIntent(trimmed);

  if (/^(止めて|停止|キャンセル|やめて|stop|cancel|pause|resume|続けて|再開|戻って|back)\b/i.test(trimmed)) {
    return {
      commandType: 'control_command',
      action: /resume|続けて|再開/i.test(trimmed)
        ? 'resume'
        : /back|戻って/i.test(trimmed)
          ? 'navigate'
          : /pause/i.test(trimmed)
            ? 'pause'
            : 'cancel',
    };
  }

  const region =
    /左下|bottom left/i.test(trimmed) ? 'bottom-left' :
      /右下|bottom right/i.test(trimmed) ? 'bottom-right' :
        /左上|top left/i.test(trimmed) ? 'top-left' :
          /右上|top right/i.test(trimmed) ? 'top-right' :
            /中央|center|真ん中/i.test(trimmed) ? 'center' :
              undefined;

  const targetTextMatch =
    trimmed.match(/「(.+?)」/) ||
    trimmed.match(/"(.+?)"/) ||
    trimmed.match(/『(.+?)』/) ||
    trimmed.match(/(.+?)を押して/) ||
    trimmed.match(/(.+?)をクリック/) ||
    trimmed.match(/(.+?)をタップ/) ||
    trimmed.match(/(.+?)ボタン/);
  const targetText = targetTextMatch?.[1]
    ?.trim()
    .replace(/^(左下|右下|左上|右上|中央|真ん中)\s*の?/, '')
    .replace(/(?:ボタン|button)$/i, '')
    .trim();
  const targetRole = /ボタン|button/i.test(trimmed) ? 'button' : undefined;

  if (resolvedSurfaceIntent.intentId === 'open-site') {
    return {
      commandType: 'task_command',
      action: 'navigate',
      targetHint: {
        text: targetText,
        region,
      },
    };
  }

  if (resolvedSurfaceIntent.intentId === 'browser-step') {
    if (/押して|press|enter/i.test(trimmed) && /(enter|return|エンター)/i.test(trimmed)) {
      return {
        commandType: 'step_command',
        action: 'press',
        targetHint: {
          text: targetText,
          region,
        },
      };
    }
    if (/入力|入れて|type|fill/i.test(trimmed)) {
      const inputTextMatch =
        trimmed.match(/「(.+?)」を.*(?:入力|入れて)/) ||
        trimmed.match(/"(.+?)".*(?:input|type|fill)/i) ||
        trimmed.match(/(.+?)\s*と入力/);
      return {
        commandType: 'step_command',
        action: 'fill',
        inputText: inputTextMatch?.[1]?.trim(),
        targetHint: {
          text: targetText,
          region,
        },
      };
    }
    if (/スクロール|scroll/i.test(trimmed)) {
      return {
        commandType: 'step_command',
        action: 'scroll',
        targetHint: {
          region,
        },
      };
    }
    return {
      commandType: 'step_command',
      action: 'click',
      targetHint: {
        text: targetText,
        region,
        role: targetRole,
      },
    };
  }

  if (/押して|click|tap|クリック/i.test(trimmed) && !/(enter|return|エンター)/i.test(trimmed)) {
    return {
      commandType: 'step_command',
      action: 'click',
      targetHint: {
        text: targetText,
        region,
        role: targetRole,
      },
    };
  }

  if (/押して|press|enter/i.test(trimmed) && /(enter|return|エンター)/i.test(trimmed)) {
    return {
      commandType: 'step_command',
      action: 'press',
      targetHint: {
        text: targetText,
        region,
      },
    };
  }

  if (/入力|入れて|type|fill/i.test(trimmed)) {
    const inputTextMatch =
      trimmed.match(/「(.+?)」を.*(?:入力|入れて)/) ||
      trimmed.match(/"(.+?)".*(?:input|type|fill)/i) ||
      trimmed.match(/(.+?)\s*と入力/);
    return {
      commandType: 'step_command',
      action: 'fill',
      inputText: inputTextMatch?.[1]?.trim(),
      targetHint: {
        text: targetText,
        region,
      },
    };
  }

  if (/スクロール|scroll/i.test(trimmed)) {
    return {
      commandType: 'step_command',
      action: 'scroll',
      targetHint: {
        region,
      },
    };
  }

  if (/開いて|open|表示して|show/i.test(trimmed) && /(ページ|tab|タブ|ブラウザ|chrome|サイト|url|画面)/i.test(trimmed)) {
    return {
      commandType: 'task_command',
      action: 'navigate',
      targetHint: {
        text: targetText,
        region,
      },
    };
  }

  return null;
}

export function createBrowserConversationCommand(params: {
  sessionId: string;
  utterance: string;
  resolution: BrowserConversationCommandResolution;
}): BrowserConversationCommand {
  return {
    kind: 'browser_session_command',
    session_id: params.sessionId,
    command_type: params.resolution.commandType,
    utterance: params.utterance,
    issued_at: new Date().toISOString(),
    resolution: {
      action: params.resolution.action,
      input_text: params.resolution.inputText,
      target_hint: params.resolution.targetHint,
    },
  };
}

export function createBrowserConversationFeedback(params: {
  sessionId: string;
  status: BrowserConversationFeedback['status'];
  message: string;
  candidates?: BrowserConversationFeedback['candidates'];
}): BrowserConversationFeedback {
  return {
    kind: 'browser_session_feedback',
    session_id: params.sessionId,
    status: params.status,
    message: params.message,
    ts: new Date().toISOString(),
    candidates: params.candidates,
  };
}

export function applyBrowserConversationCommand(sessionId: string, command: BrowserConversationCommand): BrowserConversationFeedback | null {
  const session = loadBrowserConversationSession(sessionId);
  if (!session) return null;

  session.conversation_context.last_user_instruction = command.utterance;
  session.updated_at = new Date().toISOString();

  if (command.command_type === 'control_command') {
    session.status = command.resolution?.action === 'resume' ? 'awaiting_instruction' : 'paused';
    session.control.awaiting_user_input = command.resolution?.action !== 'resume';
    const historyEntry: BrowserConversationHistoryEntry = {
      ts: command.issued_at,
      type: 'control',
      text: command.utterance,
    };
    session.history = [...session.history, historyEntry].slice(-50);
    saveBrowserConversationSession(session);
    return createBrowserConversationFeedback({
      sessionId,
      status: 'progress',
      message: command.resolution?.action === 'resume'
        ? 'ブラウザ操作を再開します。'
        : 'ブラウザ操作をいったん停止しました。',
    });
  }

  session.status = command.command_type === 'task_command' ? 'observing' : 'resolving_target';
  session.control.awaiting_user_input = false;
  session.candidate_targets = resolveCandidateTargets(sessionId, {
    commandType: command.command_type,
    action: command.resolution?.action,
    targetHint: command.resolution?.target_hint,
  });
  session.conversation_context.pending_confirmation = Boolean(command.command_type === 'step_command' && session.candidate_targets.length > 1);
  session.active_step = {
    step_id: `step-${Date.now().toString(36)}`,
    kind: command.resolution?.action === 'navigate'
      ? 'navigate'
      : command.resolution?.action === 'fill'
        ? 'fill'
        : command.resolution?.action === 'press'
          ? 'press'
        : command.resolution?.action === 'scroll'
          ? 'scroll'
          : 'click',
    description: command.utterance,
    status: 'pending',
  };
  const historyEntry: BrowserConversationHistoryEntry = {
    ts: command.issued_at,
    type: 'instruction',
    text: command.utterance,
  };
  session.history = [...session.history, historyEntry].slice(-50);
  saveBrowserConversationSession(session);

  if (session.candidate_targets.length > 1 && command.command_type === 'step_command') {
    return createBrowserConversationFeedback({
      sessionId,
      status: 'awaiting_confirmation',
      message: `候補が ${session.candidate_targets.length} 件あります。対象を確認します。`,
      candidates: session.candidate_targets.slice(0, 3).map((candidate) => ({
        element_id: candidate.element_id,
        label: candidate.label || candidate.text,
        region_hint: candidate.region_hint,
        confidence: candidate.confidence,
      })),
    });
  }

  if (session.candidate_targets.length === 1 && command.command_type === 'step_command') {
    return createBrowserConversationFeedback({
      sessionId,
      status: 'progress',
      message: `「${session.candidate_targets[0].label || command.utterance}」を対象として操作を進めます。`,
      candidates: session.candidate_targets.map((candidate) => ({
        element_id: candidate.element_id,
        label: candidate.label || candidate.text,
        region_hint: candidate.region_hint,
        confidence: candidate.confidence,
      })),
    });
  }

  return createBrowserConversationFeedback({
    sessionId,
    status: 'progress',
    message: command.command_type === 'task_command'
      ? 'ブラウザ操作の準備を始めます。'
      : '対象を確認して操作を進めます。',
  });
}

export function executeBrowserConversationAction(sessionId: string): BrowserConversationExecutionResult | null {
  const session = loadBrowserConversationSession(sessionId);
  if (!session || !session.active_step || session.candidate_targets.length === 0) return null;

  const selected = session.candidate_targets[0];
  return executeBrowserConversationCandidateAction(sessionId, selected.element_id);
}

export function executeBrowserConversationCandidateAction(
  sessionId: string,
  elementId: string,
): BrowserConversationExecutionResult | null {
  const session = loadBrowserConversationSession(sessionId);
  if (!session || !session.active_step || session.candidate_targets.length === 0) return null;

  const selected = session.candidate_targets.find((candidate) => candidate.element_id === elementId);
  if (!selected) return null;
  const browserSessionId = session.target?.browser_session_id || session.session_id;
  const browserRuntimeSession = loadBrowserRuntimeSession(browserSessionId);
  const tmpPath = pathResolver.sharedTmp(`browser-conversation/${sessionId}-${Date.now().toString(36)}.json`);
  const steps: Array<Record<string, unknown>> = [];

  if (session.target?.tab_id) {
    steps.push({
      type: 'control',
      op: 'select_tab',
      params: {
        tab_id: session.target.tab_id,
      },
    });
  }

  steps.push({
    type: 'capture',
    op: 'snapshot',
    params: {
      export_as: 'last_snapshot',
      max_elements: 200,
    },
  });

  if (session.active_step.kind === 'click') {
    steps.push({
      type: 'apply',
      op: 'click_ref',
      params: {
        ref: selected.element_id,
        timeout: 5000,
      },
    });
  } else if (session.active_step.kind === 'fill') {
    const inputText = session.conversation_context.last_user_instruction?.match(/「(.+?)」を.*(?:入力|入れて)/)?.[1]
      || session.conversation_context.last_user_instruction?.match(/"(.+?)".*(?:input|type|fill)/i)?.[1]
      || session.conversation_context.last_user_instruction?.match(/(.+?)\s*と入力/)?.[1];
    if (!inputText) {
      return {
        ok: false,
        feedback: createBrowserConversationFeedback({
          sessionId,
          status: 'blocked',
          message: '入力する値が会話から解決できませんでした。',
        }),
      };
    }
    steps.push({
      type: 'apply',
      op: 'fill_ref',
      params: {
        ref: selected.element_id,
        text: inputText,
        timeout: 5000,
      },
    });
  } else if (session.active_step.kind === 'press') {
    steps.push({
      type: 'apply',
      op: 'press_ref',
      params: {
        ref: selected.element_id,
        key: 'Enter',
        timeout: 5000,
      },
    });
  } else {
    return {
      ok: false,
      feedback: createBrowserConversationFeedback({
        sessionId,
        status: 'blocked',
        message: 'この操作種別はまだ自動実行に接続されていません。',
      }),
    };
  }

  steps.push({
    type: 'capture',
    op: 'snapshot',
    params: {
      export_as: 'last_snapshot',
      max_elements: 200,
    },
  });

  const payload = {
    action: 'pipeline',
    session_id: browserSessionId,
    options: {
      headless: false,
      keep_alive: false,
      connect_over_cdp: Boolean(browserRuntimeSession?.cdp_url),
      cdp_url: browserRuntimeSession?.cdp_url,
      cdp_port: browserRuntimeSession?.cdp_port,
    },
    steps,
  };

    safeWriteFile(tmpPath, JSON.stringify(payload, null, 2));
  try {
    const stdout = safeExec('node', [
      'dist/libs/actuators/browser-actuator/src/index.js',
      '--input',
      tmpPath,
    ], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 60_000,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    session.status = 'completed';
    session.active_step.status = 'completed';
    session.conversation_context.pending_confirmation = false;
    const historyEntry: BrowserConversationHistoryEntry = {
      ts: new Date().toISOString(),
      type: 'execution',
      text: `Executed ${session.active_step.kind} on ${selected.element_id}`,
    };
    session.history = [...session.history, historyEntry].slice(-50);
    session.updated_at = new Date().toISOString();
    saveBrowserConversationSession(session);
    return {
      ok: true,
      feedback: createBrowserConversationFeedback({
        sessionId,
        status: 'completed',
        message: `「${selected.label || selected.text || selected.element_id}」を操作しました。`,
      }),
      raw: parsed,
    };
  } catch (error: any) {
    const message = error?.message || String(error);
    session.status = 'failed';
    session.active_step.status = 'failed';
    const historyEntry: BrowserConversationHistoryEntry = {
      ts: new Date().toISOString(),
      type: 'error',
      text: message,
    };
    session.history = [...session.history, historyEntry].slice(-50);
    session.updated_at = new Date().toISOString();
    saveBrowserConversationSession(session);
    return {
      ok: false,
      feedback: createBrowserConversationFeedback({
        sessionId,
        status: 'failed',
        message: `ブラウザ操作に失敗しました: ${message}`,
      }),
    };
  }
}

export function confirmBrowserConversationCandidate(
  sessionId: string,
  utterance: string,
): BrowserConversationExecutionResult | null {
  const session = loadBrowserConversationSession(sessionId);
  if (!session || !session.conversation_context.pending_confirmation || session.candidate_targets.length === 0) {
    return null;
  }

  const candidateIndex = resolveConfirmationCandidateIndex(utterance, session.candidate_targets.length);
  if (candidateIndex === null) {
    return {
      ok: false,
      feedback: createBrowserConversationFeedback({
        sessionId,
        status: 'awaiting_confirmation',
        message: `候補は ${session.candidate_targets.length} 件あります。番号か「それ」で指定してください。`,
        candidates: session.candidate_targets.slice(0, 3).map((candidate) => ({
          element_id: candidate.element_id,
          label: candidate.label || candidate.text,
          region_hint: candidate.region_hint,
          confidence: candidate.confidence,
        })),
      }),
    };
  }

  const selected = session.candidate_targets[candidateIndex];
  session.conversation_context.last_agent_ack = `候補 ${candidateIndex + 1} を選択しました。`;
  session.updated_at = new Date().toISOString();
  saveBrowserConversationSession(session);
  return executeBrowserConversationCandidateAction(sessionId, selected.element_id);
}
