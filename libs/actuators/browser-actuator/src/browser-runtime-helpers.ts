import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
  safeRmSync,
  safeExec,
  secureFetch,
  buildGovernedRetryOptions,
  pathResolver,
  normalizeBrowserPipelineOp,
  validateOpInput,
} from '@agent/core';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';
import * as path from 'node:path';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role: string | null;
  text: string;
  name: string;
  type: string | null;
  placeholder: string | null;
  href: string | null;
  value: string | null;
  visible: boolean;
  editable: boolean;
  focused?: boolean;
  value_redacted?: boolean;
  selector: string;
}

interface BrowserSnapshot {
  session_id: string;
  tab_id: string;
  url: string;
  title: string;
  captured_at: string;
  element_count: number;
  viewport?: { width: number; height: number; scale: number };
  focused_ref?: string | null;
  ready_state?: string;
  elements: BrowserSnapshotElement[];
}

interface BrowserTabSummary {
  tab_id: string;
  url: string;
  title: string;
  active: boolean;
}

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface BrowserAction {
  action: 'pipeline';
  steps: PipelineStep[];
  session_id?: string;
}

interface BrowserRecordedAction {
  kind: 'control' | 'capture' | 'apply';
  op: string;
  tab_id?: string;
  url?: string;
  title?: string;
  ref?: string;
  selector?: string;
  text?: string;
  key?: string;
  element_name?: string;
  element_role?: string | null;
  content_excerpt?: string;
  classification?: 'user_input' | 'secret_ref';
  secret_ref?: string;
  redacted?: boolean;
  approval_request_id?: string;
  resume_status?: 'pending' | 'approved' | 'rejected' | 'expired';
  ts: string;
}

interface BrowserSessionMetadata {
  session_id: string;
  user_data_dir: string;
  active_tab_id: string;
  tab_count: number;
  tabs: BrowserTabSummary[];
  updated_at: string;
  last_trace_path?: string;
  last_video_paths?: string[];
  video_output_dir?: string;
  video_recording_pending?: boolean;
  lease_expires_at?: string;
  lease_status: 'active' | 'released' | 'expired';
  retained: boolean;
  cdp_url?: string;
  cdp_port?: number;
  action_trail_count: number;
  action_trail_path?: string;
  recent_actions: Array<{
    op: string;
    kind: 'control' | 'capture' | 'apply';
    tab_id?: string;
    ref?: string;
    selector?: string;
    ts: string;
  }>;
}

interface ChromeCdpEndpoint {
  cdpUrl: string;
  cdpPort: number;
  source: 'process' | 'probe';
}

interface BrowserRuntime {
  context: BrowserContext;
  tabs: Map<string, Page>;
  pageIds: WeakMap<Page, string>;
  cdpSessions: WeakMap<Page, CDPSession>;
  activeTabId: string;
  consoleEvents: Array<{ tab_id: string; type: string; text: string; ts: string }>;
  networkEvents: Array<{
    tab_id: string;
    method: string;
    url: string;
    resourceType: string;
    ts: string;
  }>;
  navigationPolicy?: {
    allowed_origins?: string[];
    allow_private_network?: boolean;
    allow_data_url?: boolean;
  };
  webAuthn?: {
    authenticatorId?: string;
    enabled: boolean;
    options?: Record<string, any>;
    credentials: Array<Record<string, any>>;
    events: Array<{
      type: string;
      credential?: Record<string, any>;
      credentialId?: string;
      ts: string;
    }>;
  };
}

interface BrowserRuntimeLease {
  runtime: BrowserRuntime;
  userDataDir: string;
  sessionMetadataPath: string;
  videoDir?: string;
  leaseExpiresAt?: number;
  cdpUrl?: string;
  cdpPort?: number;
  browser?: Browser;
  externalConnection?: boolean;
}

const BROWSER_RUNTIME_DIR = pathResolver.shared('runtime/browser');
const BROWSER_SESSION_DIR = path.join(BROWSER_RUNTIME_DIR, 'sessions');
const BROWSER_SNAPSHOT_DIR = path.join(BROWSER_RUNTIME_DIR, 'snapshots');
const BROWSER_ACTION_TRAIL_DIR = path.join(BROWSER_RUNTIME_DIR, 'action-trails');
const BROWSER_APPROVAL_DIR = path.join(BROWSER_RUNTIME_DIR, 'approvals');
const BROWSER_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/browser-actuator/manifest.json'
);
const browserRuntimeLeases = new Map<string, BrowserRuntimeLease>();

const DEFAULT_BROWSER_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

function buildRetryOptions(stepParams: Record<string, any>) {
  const explicitRetry =
    stepParams && typeof stepParams.retry === 'object' && !Array.isArray(stepParams.retry)
      ? { ...(stepParams.retry as Record<string, any>) }
      : {};
  if (stepParams?.max_retries !== undefined)
    explicitRetry.maxRetries = Number(stepParams.max_retries);
  if (stepParams?.retry_delay_ms !== undefined)
    explicitRetry.initialDelayMs = Number(stepParams.retry_delay_ms);
  return buildGovernedRetryOptions({
    manifestPath: BROWSER_MANIFEST_PATH,
    defaults: DEFAULT_BROWSER_RETRY,
    override: explicitRetry,
    fallbackCategories: ['network', 'timeout', 'resource_unavailable'],
    additionalShouldRetry: (error) =>
      /selector|not visible|strict mode violation|detached/i.test(error.message),
  });
}

function createBrowserRuntime(
  context: BrowserContext,
  navigationPolicy?: BrowserRuntime['navigationPolicy']
): BrowserRuntime {
  const tabs = new Map<string, Page>();
  const pageIds = new WeakMap<Page, string>();
  const cdpSessions = new WeakMap<Page, CDPSession>();
  const runtime: BrowserRuntime = {
    context,
    tabs,
    pageIds,
    cdpSessions,
    activeTabId: '',
    consoleEvents: [],
    networkEvents: [],
    navigationPolicy,
  };
  context.pages().forEach((page, index) => {
    registerBrowserPage(runtime, page, `tab-${index + 1}`);
  });
  context.on('page', (page) => {
    const tabId = `tab-${runtime.tabs.size + 1}`;
    registerBrowserPage(runtime, page, tabId);
  });
  return runtime;
}

function registerBrowserPage(runtime: BrowserRuntime, page: Page, tabId: string): void {
  runtime.tabs.set(tabId, page);
  runtime.pageIds.set(page, tabId);
  if (!runtime.activeTabId) runtime.activeTabId = tabId;
  attachPageObservers(runtime, page);
}

function attachPageObservers(runtime: BrowserRuntime, page: Page): void {
  const tabId = runtime.pageIds.get(page) || `tab-${runtime.tabs.size}`;
  page.on('dialog', async (dialog) => {
    logger.info(
      `[BROWSER] Dialog intercepted: ${dialog.type()} - "${dialog.message().substring(0, 100)}"`
    );
    await dialog.accept();
  });
  page.on('console', (msg) => {
    runtime.consoleEvents.push({
      tab_id: tabId,
      type: msg.type(),
      text: msg.text(),
      ts: new Date().toISOString(),
    });
    runtime.consoleEvents = runtime.consoleEvents.slice(-200);
  });
  page.on('request', (request) => {
    runtime.networkEvents.push({
      tab_id: tabId,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      ts: new Date().toISOString(),
    });
    runtime.networkEvents = runtime.networkEvents.slice(-200);
  });
}

function getActivePage(runtime: BrowserRuntime): Page {
  const page = runtime.tabs.get(runtime.activeTabId);
  if (!page) throw new Error(`Active browser tab not found: ${runtime.activeTabId}`);
  return page;
}

function summarizeRecentActions(trail: any): BrowserSessionMetadata['recent_actions'] {
  const actions = Array.isArray(trail)
    ? (trail as Array<{
        op: string;
        kind: 'control' | 'capture' | 'apply';
        tab_id?: string;
        ref?: string;
        selector?: string;
        ts: string;
      }>)
    : [];
  return actions.slice(-8).map((action) => ({
    op: action.op,
    kind: action.kind,
    tab_id: action.tab_id,
    ref: action.ref,
    selector: action.selector,
    ts: action.ts,
  }));
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'ip6-localhost') return true;
  const version = isIP(host);
  if (version === 6) {
    if (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80:')
    )
      return true;
    if (host.startsWith('::ffff:')) {
      const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (mapped) {
        const high = Number.parseInt(mapped[1], 16);
        const low = Number.parseInt(mapped[2], 16);
        return isPrivateHost(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
      }
      return isPrivateHost(host.slice('::ffff:'.length));
    }
    return false;
  }
  if (version !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function assertNavigationAllowed(
  url: string,
  policy: BrowserRuntime['navigationPolicy'] = {}
): void {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`[BROWSER_NAVIGATION_BLOCKED] invalid URL`);
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'about:') {
    if (parsed.protocol === 'data:' && policy.allow_data_url === false)
      throw new Error('[BROWSER_NAVIGATION_BLOCKED] data URL is disabled');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error(`[BROWSER_NAVIGATION_BLOCKED] unsupported protocol: ${parsed.protocol}`);
  if (!policy.allow_private_network && isPrivateHost(parsed.hostname))
    throw new Error(`[BROWSER_NAVIGATION_BLOCKED] private or loopback host: ${parsed.hostname}`);
  if (
    Array.isArray(policy.allowed_origins) &&
    policy.allowed_origins.length > 0 &&
    !policy.allowed_origins.includes(parsed.origin)
  )
    throw new Error(`[BROWSER_NAVIGATION_BLOCKED] origin not allowed: ${parsed.origin}`);
}

function loadBrowserSessionMetadata(filePath: string): BrowserSessionMetadata | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(
      safeReadFile(filePath, { encoding: 'utf8' }) as string
    ) as BrowserSessionMetadata;
  } catch {
    return null;
  }
}

async function waitForCdpEndpoint(
  userDataDir: string,
  timeoutMs = 5_000
): Promise<{ cdpUrl: string; cdpPort: number } | null> {
  if (process.env.VITEST) return null;
  const filePath = path.join(userDataDir, 'DevToolsActivePort');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (safeExistsSync(filePath)) {
      try {
        const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '').trim();
        const [portLine] = raw.split(/\r?\n/);
        const cdpPort = Number(portLine);
        if (Number.isFinite(cdpPort) && cdpPort > 0) {
          return {
            cdpPort,
            cdpUrl: `http://127.0.0.1:${cdpPort}`,
          };
        }
      } catch {
        // Retry until timeout.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function parseChromeRemoteDebuggingPorts(psOutput: string): number[] {
  const ports = new Set<number>();
  for (const line of psOutput.split(/\r?\n/)) {
    const matches = [...line.matchAll(/--remote-debugging-port(?:=|\s+)(\d+)/gi)];
    for (const match of matches) {
      const port = Number(match[1]);
      if (Number.isFinite(port) && port > 0 && port < 65536) {
        ports.add(port);
      }
    }
  }
  return [...ports];
}

async function probeChromeCdpPort(
  port: number,
  timeoutMs = 600
): Promise<ChromeCdpEndpoint | null> {
  try {
    const payload = await secureFetch<Record<string, unknown>>({
      method: 'GET',
      url: `http://127.0.0.1:${port}/json/version`,
      timeout: timeoutMs,
      kyberion_allow_local_network: true,
    });
    if (!payload || typeof payload !== 'object') return null;
    const webSocketDebuggerUrl = (payload as any).webSocketDebuggerUrl;
    const browser = (payload as any).Browser;
    if (typeof webSocketDebuggerUrl === 'string' || typeof browser === 'string') {
      return {
        cdpUrl: `http://127.0.0.1:${port}`,
        cdpPort: port,
        source: 'probe',
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function discoverChromeCdpEndpoint(): Promise<ChromeCdpEndpoint | null> {
  const candidatePorts = new Set<number>([9222, 9223, 9224, 9333, 9334]);
  try {
    const psOutput = String(
      safeExec('ps', ['-axo', 'pid=,command='], {
        timeoutMs: 2000,
        maxOutputMB: 2,
      }) || ''
    );
    for (const port of parseChromeRemoteDebuggingPorts(psOutput)) {
      candidatePorts.add(port);
    }
  } catch (error: any) {
    logger.info(
      `Could not inspect local process list for Chrome CDP discovery: ${error?.message || String(error)}`
    );
  }

  for (const port of candidatePorts) {
    const endpoint = await probeChromeCdpPort(port);
    if (endpoint) return endpoint;
  }

  return null;
}

async function collectRecordedVideoPaths(runtime: BrowserRuntime): Promise<string[]> {
  const collected = new Set<string>();
  for (const page of runtime.tabs.values()) {
    const videoHandle = typeof (page as any).video === 'function' ? (page as any).video() : null;
    if (!videoHandle || typeof videoHandle.path !== 'function') continue;
    try {
      const videoPath = await videoHandle.path();
      if (videoPath) collected.add(String(videoPath));
    } catch (_) {
      // Ignore pages without finalized video artifacts.
    }
  }
  return [...collected];
}

function findBrowserRuntimeLease(runtime: BrowserRuntime): BrowserRuntimeLease | undefined {
  for (const lease of browserRuntimeLeases.values()) {
    if (lease.runtime === runtime) return lease;
  }
  return undefined;
}

async function resetBrowserRuntimeLeasesForTest(): Promise<void> {
  for (const [sessionId, lease] of browserRuntimeLeases.entries()) {
    if (lease.externalConnection && lease.browser) {
      await lease.browser.close();
    } else {
      await lease.runtime.context.close();
    }
    if (safeExistsSync(lease.sessionMetadataPath)) {
      safeRmSync(lease.sessionMetadataPath, { force: true });
    }
    safeRmSync(trailPath(sessionId), { force: true });
    if (safeExistsSync(lease.userDataDir)) {
      safeRmSync(lease.userDataDir, { recursive: true, force: true });
    }
    browserRuntimeLeases.delete(sessionId);
  }
  if (safeExistsSync(BROWSER_SESSION_DIR)) {
    for (const entry of safeReaddir(BROWSER_SESSION_DIR)) {
      if (entry.endsWith('.json'))
        safeRmSync(path.join(BROWSER_SESSION_DIR, entry), { force: true });
    }
  }
  if (safeExistsSync(BROWSER_ACTION_TRAIL_DIR)) {
    for (const entry of safeReaddir(BROWSER_ACTION_TRAIL_DIR)) {
      if (entry.endsWith('.json'))
        safeRmSync(path.join(BROWSER_ACTION_TRAIL_DIR, entry), { force: true });
    }
  }
}

function saveBrowserSessionMetadata(filePath: string, metadata: BrowserSessionMetadata): void {
  safeWriteFile(filePath, JSON.stringify(metadata, null, 2));
}

function trailPath(sessionId: string): string {
  return path.join(
    BROWSER_ACTION_TRAIL_DIR,
    `${String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')}.json`
  );
}
function saveBrowserActionTrail(sessionId: string, trail: unknown[]): string {
  if (!safeExistsSync(BROWSER_ACTION_TRAIL_DIR))
    safeMkdir(BROWSER_ACTION_TRAIL_DIR, { recursive: true });
  const filePath = trailPath(sessionId);
  safeWriteFile(filePath, JSON.stringify(Array.isArray(trail) ? trail.slice(-200) : [], null, 2));
  return filePath;
}
function loadBrowserActionTrail(sessionId: string): BrowserRecordedAction[] {
  const filePath = trailPath(sessionId);
  if (!safeExistsSync(filePath)) return [];
  try {
    const value = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
    return Array.isArray(value) ? value.slice(-200) : [];
  } catch {
    return [];
  }
}
function saveFailureBundle(
  sessionId: string,
  bundle: Record<string, unknown>,
  requestedPath?: string
): string {
  const safeSessionId = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  const outPath = pathResolver.rootResolve(
    requestedPath || `active/shared/tmp/browser/${safeSessionId}-failure-bundle.json`
  );
  if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
  safeWriteFile(outPath, JSON.stringify(bundle, null, 2));
  return outPath;
}
function approvalPath(sessionId: string): string {
  return path.join(
    BROWSER_APPROVAL_DIR,
    `${String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')}.json`
  );
}
function beginOperatorApproval(options: {
  sessionId: string;
  message: string;
  continueFile: string;
  timeoutMs?: number;
}) {
  if (!safeExistsSync(BROWSER_APPROVAL_DIR)) safeMkdir(BROWSER_APPROVAL_DIR, { recursive: true });
  const request = {
    request_id: randomUUID(),
    session_id: options.sessionId,
    status: 'pending',
    message: options.message,
    continue_file: options.continueFile,
    created_at: new Date().toISOString(),
    timeout_ms: options.timeoutMs,
  };
  const filePath = approvalPath(options.sessionId);
  safeWriteFile(filePath, JSON.stringify(request, null, 2));
  return { request_id: request.request_id, path: filePath, continue_file: request.continue_file };
}
function completeOperatorApproval(
  sessionId: string,
  status: 'approved' | 'expired' | 'rejected'
): void {
  const filePath = approvalPath(sessionId);
  let current: Record<string, unknown> = {};
  if (safeExistsSync(filePath)) {
    try {
      current = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
    } catch {
      // A corrupt approval artifact is replaced with a fresh terminal state.
    }
  }
  safeWriteFile(
    filePath,
    JSON.stringify({ ...current, status, completed_at: new Date().toISOString() }, null, 2)
  );
}

function saveBrowserSessionSnapshot(sessionId: string, snapshot: BrowserSnapshot): void {
  if (!safeExistsSync(BROWSER_SNAPSHOT_DIR)) safeMkdir(BROWSER_SNAPSHOT_DIR, { recursive: true });
  safeWriteFile(
    path.join(BROWSER_SNAPSHOT_DIR, `${sessionId}.json`),
    JSON.stringify(snapshot, null, 2)
  );
}

async function summarizeTabs(runtime: BrowserRuntime): Promise<BrowserTabSummary[]> {
  const summaries: BrowserTabSummary[] = [];
  for (const [tabId, page] of runtime.tabs.entries()) {
    summaries.push({
      tab_id: tabId,
      url: page.url(),
      title: await page.title(),
      active: tabId === runtime.activeTabId,
    });
  }
  return summaries;
}
async function getSessionHealth(sessionId: string, runtime: BrowserRuntime, trail: unknown[] = []) {
  const lease = findBrowserRuntimeLease(runtime);
  const page = runtime.tabs.get(runtime.activeTabId);
  const last = Array.isArray(trail)
    ? (trail[trail.length - 1] as BrowserRecordedAction | undefined)
    : undefined;
  return {
    session_id: sessionId,
    lease_status:
      lease?.leaseExpiresAt && lease.leaseExpiresAt <= Date.now() ? 'expired' : 'active',
    lease_expires_at: lease?.leaseExpiresAt
      ? new Date(lease.leaseExpiresAt).toISOString()
      : undefined,
    active_tab_id: runtime.activeTabId,
    tab_count: runtime.tabs.size,
    active_url: page?.url() || null,
    active_tab_closed: page?.isClosed?.() ?? true,
    console_event_count: runtime.consoleEvents.length,
    network_event_count: runtime.networkEvents.length,
    action_trail_count: Array.isArray(trail) ? trail.length : 0,
    last_action_at: last?.ts,
    cdp_url: lease?.cdpUrl,
    cdp_port: lease?.cdpPort,
  };
}

async function buildSnapshot(
  page: Page,
  options: { sessionId: string; tabId: string; maxElements: number }
): Promise<BrowserSnapshot> {
  const { sessionId, tabId, maxElements } = options;
  const evaluated = await page.evaluate((max) => {
    const candidates = Array.from(
      document.querySelectorAll('a, button, input, select, textarea, summary, [role], [tabindex]')
    );
    const visible = candidates.filter((node) => {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    });

    const active = document.activeElement;
    return {
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio || 1 },
      ready_state: document.readyState,
      elements: visible.slice(0, max).map((node, index) => {
        const el = node as HTMLElement;
        const role = el.getAttribute('role');
        const aria = el.getAttribute('aria-label');
        const placeholder = el.getAttribute('placeholder');
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        const name =
          aria ||
          placeholder ||
          text ||
          el.getAttribute('name') ||
          el.id ||
          el.tagName.toLowerCase();
        const href = el instanceof HTMLAnchorElement ? el.href : null;
        const rawValue =
          'value' in el
            ? String((el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value || '')
            : null;
        const segments: string[] = [];
        let current: Element | null = el;
        while (
          current &&
          current.nodeType === Node.ELEMENT_NODE &&
          current.tagName.toLowerCase() !== 'html'
        ) {
          const tag = current.tagName.toLowerCase();
          const htmlEl = current as HTMLElement;
          if (htmlEl.id) {
            segments.unshift(`${tag}#${CSS.escape(htmlEl.id)}`);
            break;
          }
          let elementIndex = 1;
          let sibling = current.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === current.tagName) elementIndex += 1;
            sibling = sibling.previousElementSibling;
          }
          segments.unshift(`${tag}:nth-of-type(${elementIndex})`);
          current = current.parentElement;
        }
        const sensitive =
          el.getAttribute('type')?.toLowerCase() === 'password' ||
          /password|secret|token|api[_-]?key|credential/i.test(
            [el.getAttribute('name'), el.getAttribute('autocomplete'), el.id]
              .filter(Boolean)
              .join(' ')
          );
        return {
          ref: `@e${index + 1}`,
          tag: el.tagName.toLowerCase(),
          role,
          text,
          name,
          type: el.getAttribute('type'),
          placeholder,
          href,
          value: sensitive ? (rawValue ? '<redacted>' : '') : rawValue,
          value_redacted: sensitive && Boolean(rawValue),
          visible: true,
          focused: el === active,
          editable:
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement,
          selector: segments.length ? segments.join(' > ') : 'body',
        };
      }),
    };
  }, maxElements);
  const raw = Array.isArray(evaluated)
    ? { viewport: undefined, ready_state: undefined, elements: evaluated }
    : evaluated;

  return {
    session_id: sessionId,
    tab_id: tabId,
    url: page.url(),
    title: await page.title(),
    captured_at: new Date().toISOString(),
    element_count: raw.elements.length,
    viewport: raw.viewport,
    focused_ref:
      raw.elements.find((element: BrowserSnapshotElement) => element.focused)?.ref || null,
    ready_state: raw.ready_state,
    elements: raw.elements,
  };
}

async function buildSessionHandoff(
  page: Page,
  runtime: BrowserRuntime,
  ctx: any,
  options: {
    targetUrl: string;
    origin: string;
    browserSessionId: string;
    preferPersistentContext: boolean;
  }
) {
  const storage = await page.evaluate(() => ({
    local_storage: Object.fromEntries(Object.entries(window.localStorage)),
    session_storage: Object.fromEntries(Object.entries(window.sessionStorage)),
  }));
  const cookies = await runtime.context.cookies([options.targetUrl]);
  return {
    kind: 'webview-session-handoff',
    target_url: options.targetUrl,
    origin: options.origin,
    browser_session_id: options.browserSessionId,
    prefer_persistent_context: options.preferPersistentContext,
    cookies,
    local_storage: storage.local_storage,
    session_storage: storage.session_storage,
    source: {
      platform: 'browser',
      app_id: ctx?.app_profile?.app_id || ctx?.app_id || ctx?.session_id || 'browser',
    },
  };
}

async function resolveSessionHandoff(
  params: any,
  ctx: any,
  resolve: (value: any) => any
): Promise<any> {
  if (params.from) {
    const fromValue = ctx[String(params.from)];
    if (fromValue && typeof fromValue === 'object') return fromValue;
  }

  if (params.path) {
    const filePath = pathResolver.rootResolve(resolve(params.path));
    const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  }

  if (params.handoff && typeof params.handoff === 'object') {
    return params.handoff;
  }

  throw new Error('import_session_handoff requires params.from, params.path, or params.handoff');
}

function deriveOrigin(targetUrl: string): string {
  try {
    return new URL(targetUrl).origin;
  } catch {
    return '';
  }
}

function resolveRefSelector(ctx: any, ref: string): string {
  const selector = ctx?.ref_map?.[ref];
  if (!selector) {
    throw new Error(`Unknown browser ref: ${ref}. Capture a snapshot before using *_ref actions.`);
  }
  return selector;
}

function findSnapshotElement(ctx: any, ref: string): BrowserSnapshotElement | undefined {
  const elements = ctx?.last_snapshot?.elements;
  if (!Array.isArray(elements)) return undefined;
  return elements.find((element: BrowserSnapshotElement) => element.ref === ref);
}

function recordBrowserAction(ctx: any, action: Omit<BrowserRecordedAction, 'ts'>): any {
  const trail = Array.isArray(ctx?.action_trail) ? ctx.action_trail : [];
  const sensitive =
    action.classification === 'secret_ref' ||
    action.op === 'fill_secret_ref' ||
    Boolean(action.secret_ref);
  const { text, secret_ref, ...safeAction } = action;
  const recorded = {
    ...safeAction,
    ...(sensitive
      ? { redacted: true, classification: 'secret_ref', ...(secret_ref ? { secret_ref } : {}) }
      : text !== undefined
        ? { text }
        : {}),
    ts: new Date().toISOString(),
  };
  const max = Math.max(1, Math.min(2000, Number(ctx?.action_trail_max || 200)));
  return {
    ...ctx,
    action_trail: [...trail, recorded].slice(-max),
  };
}

function readRecordedActions(ctx: any, from?: string): BrowserRecordedAction[] {
  const candidate = from ? ctx?.[from] : ctx?.action_trail;
  if (!Array.isArray(candidate)) return [];
  return candidate as BrowserRecordedAction[];
}

function renderPlaywrightSkeleton(
  trail: BrowserRecordedAction[],
  options: { assertions?: 'hint' | 'strict' } = {}
): string {
  const assertionMode = options.assertions || 'strict';
  const lines = [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('browser recorded flow', async ({ page }) => {",
  ];
  const setupLines: string[] = [];
  const actionLines: string[] = [];
  const assertionLines: string[] = [];
  let stepNumber = 0;

  const addAction = (statement: string, label?: string) => {
    stepNumber += 1;
    actionLines.push(`  // step ${stepNumber}: ${label || 'browser action'}`);
    actionLines.push(`  ${statement}`);
  };
  const addAssertion = (statement: string, label?: string) => {
    const rendered =
      assertionMode === 'strict' ? `  ${statement}` : `  // assertion hint: ${statement}`;
    if (label) assertionLines.push(`  // ${label}`);
    assertionLines.push(rendered);
  };

  for (const action of trail) {
    const op = normalizeBrowserPipelineOp(action.op);
    const validation = validateOpInput('browser', op, action);
    if (!validation.valid) {
      throw new Error(
        `[INVALID_OP_INPUT] browser:${op}: ${'errors' in validation ? validation.errors.join('; ') : ''}`
      );
    }
    switch (op) {
      case 'goto':
      case 'open_tab':
        if (action.url) {
          addAction(`await page.goto(${JSON.stringify(action.url)});`, `navigate to ${action.url}`);
          addAssertion(
            `await expect(page).toHaveURL(${JSON.stringify(action.url)});`,
            'navigation assertion'
          );
        }
        break;
      case 'snapshot':
        if (action.url)
          addAssertion(
            `await expect(page).toHaveURL(${JSON.stringify(action.url)});`,
            'snapshot assertion'
          );
        if (action.title)
          addAssertion(`await expect(page).toHaveTitle(${JSON.stringify(action.title)});`);
        break;
      case 'click':
        if (action.selector) {
          addAssertion(
            `await expect(page.locator(${JSON.stringify(action.selector)})).toBeVisible();`,
            `before click${action.element_name ? `: ${action.element_name}` : ''}`
          );
          addAction(
            `await page.click(${JSON.stringify(action.selector)});`,
            `click ${action.ref || action.selector}`
          );
        }
        break;
      case 'fill':
        if (action.selector) {
          addAssertion(
            `await expect(page.locator(${JSON.stringify(action.selector)})).toBeVisible();`,
            `before fill${action.element_name ? `: ${action.element_name}` : ''}`
          );
          if (action.secret_ref || action.classification === 'secret_ref') {
            if (!action.secret_ref) {
              throw new Error(
                '[INVALID_OP_INPUT] browser:fill_ref: secret_ref is required for secret fills'
              );
            }
            addAction(
              `await page.fill(${JSON.stringify(action.selector)}, process.env[${JSON.stringify(action.secret_ref)}] ?? '');`,
              `fill secret ${action.ref || action.selector}`
            );
          } else {
            addAction(
              `await page.fill(${JSON.stringify(action.selector)}, ${JSON.stringify(action.text || '')});`,
              `fill ${action.ref || action.selector}`
            );
            addAssertion(
              `await expect(page.locator(${JSON.stringify(action.selector)})).toHaveValue(${JSON.stringify(action.text || '')});`,
              'value assertion'
            );
          }
        }
        break;
      case 'fill_secret_ref':
        if (action.selector && action.secret_ref) {
          addAssertion(
            `await expect(page.locator(${JSON.stringify(action.selector)})).toBeVisible();`,
            'before secret fill'
          );
          addAction(
            `await page.fill(${JSON.stringify(action.selector)}, process.env[${JSON.stringify(action.secret_ref)}] ?? '');`,
            `fill secret ${action.ref || action.selector}`
          );
        }
        break;
      case 'press':
        if (action.selector) {
          addAssertion(
            `await expect(page.locator(${JSON.stringify(action.selector)})).toBeVisible();`,
            'before keypress'
          );
          addAction(
            `await page.press(${JSON.stringify(action.selector)}, ${JSON.stringify(action.key || 'Enter')});`,
            `press ${action.key || 'Enter'}`
          );
        }
        break;
      case 'wait':
        if (action.selector) {
          addAction(
            `await page.waitForSelector(${JSON.stringify(action.selector)});`,
            `wait for ${action.ref || action.selector}`
          );
          addAssertion(
            `await expect(page.locator(${JSON.stringify(action.selector)})).toBeVisible();`,
            'wait assertion'
          );
        }
        break;
      case 'content':
        if (action.selector && action.content_excerpt) {
          addAssertion(
            `await expect(page.locator(${JSON.stringify(action.selector)})).toContainText(${JSON.stringify(action.content_excerpt)});`,
            'content assertion'
          );
        }
        break;
      default:
        break;
    }
  }

  if (setupLines.length > 0) {
    lines.push('  // setup');
    lines.push(...setupLines);
    lines.push('');
  }
  if (actionLines.length > 0) {
    lines.push('  // recorded actions');
    lines.push(...actionLines);
    lines.push('');
  }
  if (assertionLines.length > 0) {
    lines.push(`  // ${assertionMode === 'strict' ? 'assertions' : 'assertion hints'}`);
    lines.push(...assertionLines);
    lines.push('');
  }
  lines.push('});', '');
  return lines.join('\n');
}

function renderBrowserAdf(trail: BrowserRecordedAction[], sessionId: string): BrowserAction {
  const steps: PipelineStep[] = [];
  for (const action of trail) {
    const op = normalizeBrowserPipelineOp(action.op);
    const validation = validateOpInput('browser', op, action);
    if (!validation.valid) {
      throw new Error(
        `[INVALID_OP_INPUT] browser:${op}: ${'errors' in validation ? validation.errors.join('; ') : ''}`
      );
    }
    switch (op) {
      case 'goto':
      case 'open_tab':
        if (action.url) steps.push({ type: 'capture', op: 'goto', params: { url: action.url } });
        break;
      case 'click':
        if (action.ref) steps.push({ type: 'apply', op: 'click_ref', params: { ref: action.ref } });
        break;
      case 'fill':
        if (action.ref)
          steps.push(
            action.secret_ref || action.classification === 'secret_ref'
              ? {
                  type: 'apply',
                  op: 'fill_secret_ref',
                  params: { ref: action.ref, secret_ref: action.secret_ref },
                }
              : {
                  type: 'apply',
                  op: 'fill_ref',
                  params: { ref: action.ref, text: action.text || '' },
                }
          );
        break;
      case 'press':
        if (action.ref)
          steps.push({
            type: 'apply',
            op: 'press_ref',
            params: { ref: action.ref, key: action.key || 'Enter' },
          });
        break;
      case 'wait':
        if (action.ref) steps.push({ type: 'apply', op: 'wait_ref', params: { ref: action.ref } });
        break;
      case 'click_ref':
        if (action.selector)
          steps.push({ type: 'apply', op: 'click', params: { selector: action.selector } });
        break;
      case 'fill_ref':
        if (action.selector)
          steps.push({
            type: 'apply',
            op: 'fill',
            params: { selector: action.selector, text: action.text || '' },
          });
        break;
      case 'fill_secret_ref':
        if (action.ref && action.secret_ref)
          steps.push({
            type: 'apply',
            op: 'fill_secret_ref',
            params: { ref: action.ref, secret_ref: action.secret_ref },
          });
        break;
      case 'press_ref':
        if (action.selector)
          steps.push({
            type: 'apply',
            op: 'press',
            params: { selector: action.selector, key: action.key || 'Enter' },
          });
        break;
      case 'wait_ref':
        if (action.selector)
          steps.push({ type: 'apply', op: 'wait', params: { selector: action.selector } });
        break;
      default:
        break;
    }
  }

  return {
    action: 'pipeline',
    session_id: sessionId,
    steps,
  } as BrowserAction;
}

async function closeBrowserSession(sessionId: string): Promise<boolean> {
  cleanupExpiredBrowserRuntimeLeases();
  const lease = browserRuntimeLeases.get(sessionId);
  if (!lease) return false;
  saveBrowserSessionMetadata(lease.sessionMetadataPath, {
    session_id: sessionId,
    user_data_dir: lease.userDataDir,
    active_tab_id: lease.runtime.activeTabId,
    tab_count: lease.runtime.tabs.size,
    tabs: [],
    updated_at: new Date().toISOString(),
    lease_status: 'released',
    retained: false,
    cdp_url: lease.cdpUrl,
    cdp_port: lease.cdpPort,
    lease_expires_at: undefined,
    action_trail_count: 0,
    recent_actions: [],
  });
  if (lease.externalConnection && lease.browser) {
    await lease.browser.close();
  } else {
    await lease.runtime.context.close();
  }
  browserRuntimeLeases.delete(sessionId);
  return true;
}

async function restartBrowserSession(sessionId: string): Promise<boolean> {
  const closed = await closeBrowserSession(sessionId);
  return closed;
}

async function waitForOperatorContinue(options: {
  sessionId: string;
  message: string;
  continueFile?: string;
  pollMs: number;
  timeoutMs?: number;
}): Promise<void> {
  const startedAt = Date.now();
  if (process.stdin.isTTY) {
    logger.info(`⏸️ [BROWSER] ${options.message}`);
    logger.info('⏎ [BROWSER] Press Enter in this terminal when manual browser work is complete.');
    await new Promise<void>((resolve) => {
      const onData = () => {
        process.stdin.off('data', onData);
        resolve();
      };
      process.stdin.resume();
      process.stdin.once('data', onData);
    });
    return;
  }

  const continueFile =
    options.continueFile || path.join(BROWSER_RUNTIME_DIR, `${options.sessionId}.continue`);
  logger.info(`⏸️ [BROWSER] ${options.message}`);
  logger.info(`📄 [BROWSER] Waiting for continue file: ${continueFile}`);
  while (true) {
    if (safeExistsSync(continueFile)) return;
    if (options.timeoutMs && Date.now() - startedAt > options.timeoutMs) {
      throw new Error(`Timed out waiting for operator continue file: ${continueFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

export const browserRuntimeHelpers = {
  createBrowserRuntime,
  registerBrowserPage,
  attachPageObservers,
  getActivePage,
  summarizeRecentActions,
  loadBrowserSessionMetadata,
  waitForCdpEndpoint,
  parseChromeRemoteDebuggingPorts,
  probeChromeCdpPort,
  discoverChromeCdpEndpoint,
  collectRecordedVideoPaths,
  findBrowserRuntimeLease,
  resetBrowserRuntimeLeasesForTest,
  summarizeTabs,
  saveBrowserSessionMetadata,
  saveBrowserSessionSnapshot,
  buildSnapshot,
  buildSessionHandoff,
  resolveSessionHandoff,
  deriveOrigin,
  resolveRefSelector,
  findSnapshotElement,
  recordBrowserAction,
  readRecordedActions,
  renderPlaywrightSkeleton,
  renderBrowserAdf,
  closeBrowserSession,
  restartBrowserSession,
  waitForOperatorContinue,
  assertNavigationAllowed,
  saveBrowserActionTrail,
  loadBrowserActionTrail,
  saveFailureBundle,
  beginOperatorApproval,
  completeOperatorApproval,
  getSessionHealth,
  cleanupExpiredBrowserRuntimeLeases,
  getOrCreateBrowserContext: async (
    sessionId: string,
    userDataDir: string,
    sessionMetadataPath: string,
    options: any,
    videoDir: string
  ): Promise<BrowserContext> => {
    cleanupExpiredBrowserRuntimeLeases();
    const existing = browserRuntimeLeases.get(sessionId);
    if (existing) {
      logger.info(`♻️ [BROWSER] Reusing leased session: ${sessionId}`);
      return existing.runtime.context;
    }

    const persistedMetadata = loadBrowserSessionMetadata(sessionMetadataPath);
    const persistedCdpUrl = options.cdp_url || persistedMetadata?.cdp_url;
    const persistedCdpPort = Number(options.cdp_port || persistedMetadata?.cdp_port || 0);

    if (
      !options.connect_over_cdp &&
      persistedCdpUrl &&
      persistedMetadata?.retained &&
      persistedMetadata.lease_status === 'active'
    ) {
      try {
        logger.info(`🔁 [BROWSER] Reattaching to persisted session via CDP: ${persistedCdpUrl}`);
        const browser = await chromium.connectOverCDP(persistedCdpUrl);
        const context = browser.contexts()[0];
        if (!context) {
          await browser.close();
          throw new Error(
            `No browser context available via persisted CDP session at ${persistedCdpUrl}`
          );
        }
        browserRuntimeLeases.set(sessionId, {
          runtime: createBrowserRuntime(context, options.navigation_policy),
          userDataDir,
          sessionMetadataPath,
          videoDir,
          browser,
          externalConnection: true,
          cdpUrl: persistedCdpUrl,
          cdpPort: persistedCdpPort || Number(new URL(persistedCdpUrl).port),
        });
        return context;
      } catch (error: any) {
        logger.warn(
          `⚠️ [BROWSER] Failed to reattach persisted session ${sessionId} via CDP: ${error?.message || String(error)}`
        );
      }
    }

    if (options.connect_over_cdp) {
      const discoveredEndpoint =
        options.cdp_url || options.cdp_port ? null : await discoverChromeCdpEndpoint();
      const cdpUrl =
        options.cdp_url ||
        (options.cdp_port ? `http://127.0.0.1:${Number(options.cdp_port || 9222)}` : undefined) ||
        discoveredEndpoint?.cdpUrl ||
        persistedCdpUrl ||
        'http://127.0.0.1:9222';
      if (discoveredEndpoint && !options.cdp_url && !options.cdp_port) {
        logger.info(
          `🔎 [BROWSER] Auto-discovered Chrome via CDP (${discoveredEndpoint.source}): ${cdpUrl}`
        );
      }
      logger.info(`🔌 [BROWSER] Attaching to existing Chrome via CDP: ${cdpUrl}`);
      const browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close();
        throw new Error(`No browser context available via CDP at ${cdpUrl}`);
      }
      browserRuntimeLeases.set(sessionId, {
        runtime: createBrowserRuntime(context, options.navigation_policy),
        userDataDir,
        sessionMetadataPath,
        videoDir,
        browser,
        externalConnection: true,
        cdpUrl,
        cdpPort: Number(new URL(cdpUrl).port),
      });
      return context;
    }

    logger.info(
      `🚀 [BROWSER] Launching session: ${sessionId} (Headless: ${options.headless !== false})`
    );
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: options.browser_channel === 'chrome' ? 'chrome' : undefined,
      headless: options.headless !== false,
      viewport: options.viewport || { width: 1280, height: 720 },
      locale: options.locale || 'ja-JP',
      recordVideo: options.record_video ? { dir: videoDir } : undefined,
      args: [
        ...(Array.isArray(options.launch_args) ? options.launch_args : []),
        ...(options.profile_directory ? [`--profile-directory=${options.profile_directory}`] : []),
        '--remote-debugging-port=0',
      ],
    });

    const cdpEndpoint = await waitForCdpEndpoint(userDataDir);
    browserRuntimeLeases.set(sessionId, {
      runtime: createBrowserRuntime(context, options.navigation_policy),
      userDataDir,
      sessionMetadataPath,
      videoDir,
      externalConnection: false,
      cdpUrl: cdpEndpoint?.cdpUrl,
      cdpPort: cdpEndpoint?.cdpPort,
    });
    return context;
  },
  getOrCreateBrowserRuntime: (
    sessionId: string,
    context: BrowserContext,
    userDataDir: string,
    sessionMetadataPath: string
  ): BrowserRuntime => {
    const existing = browserRuntimeLeases.get(sessionId);
    if (existing) return existing.runtime;
    const runtime = createBrowserRuntime(context);
    browserRuntimeLeases.set(sessionId, {
      runtime,
      userDataDir,
      sessionMetadataPath,
      externalConnection: false,
    });
    return runtime;
  },
};

function cleanupExpiredBrowserRuntimeLeases(): void {
  const now = Date.now();
  for (const [sessionId, lease] of browserRuntimeLeases.entries()) {
    if (!lease.leaseExpiresAt || lease.leaseExpiresAt > now) continue;
    saveBrowserSessionMetadata(lease.sessionMetadataPath, {
      session_id: sessionId,
      user_data_dir: lease.userDataDir,
      active_tab_id: lease.runtime.activeTabId,
      tab_count: lease.runtime.tabs.size,
      tabs: [],
      updated_at: new Date().toISOString(),
      video_output_dir: lease.videoDir,
      video_recording_pending: false,
      lease_status: 'expired',
      retained: false,
      cdp_url: lease.cdpUrl,
      cdp_port: lease.cdpPort,
      lease_expires_at: new Date(lease.leaseExpiresAt).toISOString(),
      action_trail_count: 0,
      recent_actions: [],
    });
    if (lease.externalConnection && lease.browser) {
      void lease.browser.close();
    } else {
      void lease.runtime.context.close();
    }
    browserRuntimeLeases.delete(sessionId);
  }
}
