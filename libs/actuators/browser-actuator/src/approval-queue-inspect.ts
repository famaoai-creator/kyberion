import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { runExternalOperation } from '@agent/core/governance/external-operation';
import { isDelegableExternalOperation } from '@agent/core/governance/external-operation-target';
import { currentScopeEnvelope } from '@agent/core/scope-envelope';
import { resolveScopeContext } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { getSecret } from '@agent/core/secret/secret-guard';
import { buildEnvSecretName, normalizeSecretKey } from '@agent/core/secret/secret-identity';
import { isRecord } from '@agent/core/foundation';
import {
  AUTHENTICATED_ORIGIN_SET_CAPABILITY,
  authenticatedConfinementBlocks,
  authenticatedOriginLaunchArgs,
  installAuthenticatedOriginConfinement,
  isConfinedOriginUrl,
  normalizeConfinedOrigin,
} from './browser-navigation-confinement.js';

const OPERATION_ID = 'browser:approval_queue_inspect';
const INPUT_KEYS = new Set([
  'profile',
  'origin',
  'headless',
  'export_as',
  '_reasoning_policy',
  '_facets',
  '_step_id',
]);
const ACTION_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 60_000;
/** Whole sign-in-and-read budget; a scheduler kill must never be the timeout. */
const OPERATION_DEADLINE_MS = 180_000;
const DEFAULT_MAX_ITEMS = 200;
const MAX_ITEMS_CEILING = 1000;
const MAX_NAVIGATE_STEPS = 20;
const MAX_FIELDS = 16;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_VALUE_CHARS = 512;
/** Items carry tenant-confidential text into pipeline context and traces. */
const MAX_ITEMS_CHARS = 256 * 1024;
/** Verbs that decide an item. Matched against the whole, whitespace-free label
 * so list links such as 「承認待ち一覧」 stay navigable. Defence in depth only:
 * the signed profile hash is what bounds the delegated procedure. */
const DECISIVE_LABEL =
  /^(?:一括|選択)?(?:承認|却下|差戻|差し戻|否認|決裁|確定)(?:し|す|する|します|実行|処理)?$|^(?:approve|reject|decline)(?:all|selected)?$/i;

export type ApprovalQueueNavigateStep =
  { goto: string } | { click: string; has_text?: string } | { wait_for: string };

export interface ApprovalQueueProfile {
  version: 1;
  system: string;
  origins: string[];
  credential: { service: string; user_key: string; password_key: string };
  login: {
    url: string;
    user_selector: string;
    password_selector: string;
    submit_selector: string;
    success_selector: string;
    failure_selector?: string;
  };
  navigate?: ApprovalQueueNavigateStep[];
  list: {
    ready_selector: string;
    row_selector: string;
    /** Shown when nothing is pending; zero rows without it is not a result. */
    empty_selector: string;
    /** Element whose first number is the system's own pending total. */
    total_selector?: string;
    /** CSS selectors relative to a row. */
    fields?: Record<string, string>;
    max_items?: number;
  };
}

export interface ApprovalQueueInspection {
  system: string;
  origin: string;
  pending_count: number;
  count_basis: 'rendered_rows' | 'total_indicator';
  rendered_rows: number;
  items: Array<Record<string, string>>;
  truncated: boolean;
  truncated_reason?: 'max_items' | 'output_size' | 'not_rendered';
  extraction_misses: number;
  clipped_values: number;
  observed_at: string;
  final_url: string;
}

type Evidence = Record<string, string | number | undefined>;

function formatEvidence(evidence: Evidence): string {
  return Object.entries(evidence)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

/** `[CODE] what — why | next: … | evidence: …` */
function diagnostic(
  code: string,
  what: string,
  why: string,
  next: string,
  evidence: Evidence = {}
) {
  const tail = formatEvidence(evidence);
  return new Error(
    `[${code}] ${what} — ${why} | next: ${next}${tail ? ` | evidence: ${tail}` : ''}`
  );
}

const SESSION_URL = /\b(?:https?|wss?):\/\/[^\s'"<>)]+/g;

/** First line of a driver error, with every URL reduced to origin and path. */
function safeCause(error: unknown): string {
  const first = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
  return first
    .replace(SESSION_URL, (raw) => {
      try {
        return sessionFreeUrl(raw);
      } catch {
        return '(url)';
      }
    })
    .slice(0, 300);
}

function describe(value: unknown): string {
  if (value === undefined) return 'missing';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function profileError(source: string, field: string, problem: string, next: string): never {
  throw diagnostic(
    'APPROVAL_QUEUE_PROFILE',
    `${field} ${problem}`,
    'the profile cannot run as written',
    next,
    { profile: source }
  );
}

export function parseApprovalQueueProfile(raw: unknown, source = 'profile'): ApprovalQueueProfile {
  const fail = (field: string, problem: string, next: string): never =>
    profileError(source, field, problem, next);
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim())
      fail(field, `must be a non-empty string (got ${describe(value)})`, `set ${field}`);
    return value as string;
  };
  if (!isRecord(raw)) return fail('profile', 'must be a JSON object', 'see the README example');
  if (raw.version !== 1)
    fail('version', `must be 1 (got ${describe(raw.version)})`, 'set "version": 1');
  const system = text(raw.system, 'system');
  if (!Array.isArray(raw.origins) || raw.origins.length === 0)
    fail('origins', 'must list at least one HTTPS origin', 'add e.g. "https://wf.example.jp"');
  const origins = (raw.origins as unknown[]).map((origin, index) => {
    const field = `origins[${index}]`;
    try {
      return normalizeConfinedOrigin(text(origin, field));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[APPROVAL_QUEUE_')) throw error;
      return fail(
        field,
        `is not an exact HTTPS origin (got ${describe(origin)})`,
        'use scheme, host and optional port only, e.g. "https://wf.example.jp"'
      );
    }
  });
  const originSet = new Set(origins);
  const inside = (url: string, field: string) => {
    if (!url.startsWith('https:'))
      fail(field, `must use https (got ${describe(url)})`, 'use the HTTPS address');
    if (!isConfinedOriginUrl(url, originSet))
      fail(
        field,
        `is outside the declared origins (got ${describe(url)})`,
        `add its origin to origins, or use a URL under ${origins.join(', ')}`
      );
    return url;
  };
  if (!isRecord(raw.credential))
    fail('credential', 'is required', 'set credential.service, user_key and password_key');
  const credentialRaw = raw.credential as Record<string, unknown>;
  const credential = {
    service: text(credentialRaw.service, 'credential.service'),
    user_key: text(credentialRaw.user_key, 'credential.user_key'),
    password_key: text(credentialRaw.password_key, 'credential.password_key'),
  };
  for (const field of ['user_key', 'password_key'] as const) {
    const key = credential[field];
    let canonical = '';
    try {
      canonical = normalizeSecretKey(key);
      approvalQueueSecretName(credential.service, key);
    } catch {
      canonical = '';
    }
    if (canonical.toLowerCase() !== key.toLowerCase())
      fail(
        `credential.${field}`,
        `is not a secret key name (got ${describe(key)})`,
        'use letters, digits and _ starting with a letter (e.g. login_user), and a lowercase service id'
      );
  }
  if (!isRecord(raw.login)) fail('login', 'is required', 'set the login block');
  const loginRaw = raw.login as Record<string, unknown>;
  const login = {
    url: inside(text(loginRaw.url, 'login.url'), 'login.url'),
    user_selector: text(loginRaw.user_selector, 'login.user_selector'),
    password_selector: text(loginRaw.password_selector, 'login.password_selector'),
    submit_selector: text(loginRaw.submit_selector, 'login.submit_selector'),
    success_selector: text(loginRaw.success_selector, 'login.success_selector'),
    ...(loginRaw.failure_selector !== undefined
      ? { failure_selector: text(loginRaw.failure_selector, 'login.failure_selector') }
      : {}),
  };
  if (raw.navigate !== undefined && !Array.isArray(raw.navigate))
    fail('navigate', 'must be an array', 'use a list of goto / click / wait_for steps');
  const navigateRaw = (raw.navigate as unknown[] | undefined) ?? [];
  if (navigateRaw.length > MAX_NAVIGATE_STEPS)
    fail(
      'navigate',
      `has ${navigateRaw.length} steps (at most ${MAX_NAVIGATE_STEPS})`,
      'navigate with goto to the list URL instead of clicking through menus'
    );
  const navigate = navigateRaw.map((step, index): ApprovalQueueNavigateStep => {
    const field = `navigate[${index}]`;
    if (!isRecord(step))
      return fail(field, 'must be an object', 'use { "goto": "..." } and similar');
    const unknown = Object.keys(step).filter(
      (key) => !['goto', 'click', 'has_text', 'wait_for'].includes(key)
    );
    if (unknown.length)
      fail(
        field,
        `has unsupported keys: ${unknown.join(', ')}`,
        'use goto, click, has_text or wait_for'
      );
    if (step.goto !== undefined && Object.keys(step).length === 1)
      return { goto: inside(text(step.goto, `${field}.goto`), `${field}.goto`) };
    if (step.wait_for !== undefined && Object.keys(step).length === 1)
      return { wait_for: text(step.wait_for, `${field}.wait_for`) };
    if (step.click !== undefined && step.goto === undefined && step.wait_for === undefined)
      return {
        click: text(step.click, `${field}.click`),
        ...(step.has_text !== undefined
          ? { has_text: text(step.has_text, `${field}.has_text`) }
          : {}),
      };
    return fail(
      field,
      `combines ${Object.keys(step).join(' + ')}`,
      'use exactly one of goto, click (+ has_text) or wait_for per step'
    );
  });
  if (!isRecord(raw.list)) fail('list', 'is required', 'set the list block');
  const listRaw = raw.list as Record<string, unknown>;
  const fields = listRaw.fields;
  if (fields !== undefined) {
    if (!isRecord(fields))
      fail('list.fields', 'must map names to CSS selectors', 'e.g. { "title": "td.subject" }');
    const entries = Object.entries(fields as Record<string, unknown>);
    if (entries.length > MAX_FIELDS)
      fail(
        'list.fields',
        `has ${entries.length} fields (at most ${MAX_FIELDS})`,
        'keep the columns a reader needs'
      );
    for (const [name, selector] of entries) {
      if (!FIELD_NAME.test(name))
        fail(
          `list.fields.${name}`,
          'is not a valid field name',
          'use lowercase letters, digits and _ (start with a letter, at most 32)'
        );
      text(selector, `list.fields.${name}`);
    }
  }
  const maxItems = listRaw.max_items;
  if (
    maxItems !== undefined &&
    (!Number.isInteger(maxItems) ||
      (maxItems as number) < 1 ||
      (maxItems as number) > MAX_ITEMS_CEILING)
  )
    fail(
      'list.max_items',
      `must be an integer within 1..${MAX_ITEMS_CEILING} (got ${describe(maxItems)})`,
      `omit it for the default ${DEFAULT_MAX_ITEMS}`
    );
  return {
    version: 1,
    system,
    origins,
    credential,
    login,
    navigate,
    list: {
      ready_selector: text(listRaw.ready_selector, 'list.ready_selector'),
      row_selector: text(listRaw.row_selector, 'list.row_selector'),
      empty_selector: text(listRaw.empty_selector, 'list.empty_selector'),
      ...(listRaw.total_selector !== undefined
        ? { total_selector: text(listRaw.total_selector, 'list.total_selector') }
        : {}),
      ...(fields ? { fields: fields as Record<string, string> } : {}),
      ...(maxItems !== undefined ? { max_items: maxItems as number } : {}),
    },
  };
}

/** Origin and path only: queries, fragments and ;jsessionid-style path
 * parameters can carry session tokens. */
export function sessionFreeUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname.split(';')[0]}`;
}

/** The secret-guard key a profile credential resolves to; the same name
 * `pnpm kyberion secret introduce <service> <key>` stores. */
export function approvalQueueSecretName(service: string, key: string): string {
  return buildEnvSecretName(service, key);
}

/** SHA-256 of the profile file bytes; equal to `shasum -a 256 <file>`. */
export function approvalQueueProfileHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function isDecisiveLabel(label: string): boolean {
  return DECISIVE_LABEL.test(label.replace(/\s+/g, ''));
}

async function labelsOf(target: Locator): Promise<string[]> {
  return target.evaluate((element) => {
    const node = element as HTMLElement & { value?: unknown };
    return [
      node.innerText || node.textContent || '',
      typeof node.value === 'string' ? node.value : '',
      node.getAttribute('aria-label') || '',
      node.getAttribute('title') || '',
    ]
      .map((part) => part.trim())
      .filter(Boolean);
  });
}

async function guardedClick(page: Page, field: string, selector: string, hasText?: string) {
  const target = page.locator(selector, hasText ? { hasText } : undefined).first();
  await target.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  const decisive = (await labelsOf(target)).find(isDecisiveLabel);
  if (decisive)
    throw diagnostic(
      'APPROVAL_QUEUE_DECISIVE_CLICK',
      `${field} would press "${decisive}"`,
      'inspection never presses approve, reject or return controls',
      `point ${field} at a list link or button instead`,
      { step: field, selector }
    );
  await target.click({ timeout: ACTION_TIMEOUT_MS });
}

function readCredential(profile: ApprovalQueueProfile, key: string, source: string): string {
  const service = profile.credential.service;
  const name = approvalQueueSecretName(service, key);
  let value: string | undefined;
  let cause = '';
  try {
    value = getSecret(name, service, OPERATION_ID) || undefined;
  } catch (error) {
    cause = safeCause(error);
  }
  if (value) return value;
  throw diagnostic(
    'APPROVAL_QUEUE_CREDENTIAL',
    `Credential ${service}/${key} is unavailable`,
    cause || `secret-guard has no value for ${name}`,
    `register it with \`pnpm kyberion secret introduce ${service} ${normalizeSecretKey(key)}\` and list ${service} in the pipeline runtime.authorized_scope`,
    { profile: source, secret: name }
  );
}

async function fillSecret(page: Page, selector: string, value: string): Promise<void> {
  try {
    await page.locator(selector).first().fill(value, { timeout: ACTION_TIMEOUT_MS });
  } catch {
    // The driver's call log may echo the value; report only the selector.
    throw new Error(`could not fill ${selector}`);
  }
}

const PHASE_HINTS: Array<[RegExp, string, string]> = [
  [
    /^launch$/,
    'APPROVAL_QUEUE_LAUNCH',
    'install Chromium with `pnpm exec playwright install chromium`',
  ],
  [
    /^login/,
    'APPROVAL_QUEUE_LOGIN',
    'check the credential and the login selectors; run once with headless: false to watch the sign-in',
  ],
  [
    /^navigate/,
    'APPROVAL_QUEUE_NAVIGATE',
    'check this navigate step; if blocked_hosts names a host the page needs, add its origin (delegation then needs a single-origin system)',
  ],
  [/^list/, 'APPROVAL_QUEUE_LIST', 'check list.ready_selector, row_selector and empty_selector'],
];

interface Session {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  phase: string;
  expired: boolean;
}

function sessionEvidence(session: Session, source: string): Evidence {
  let url: string | undefined;
  try {
    const current = session.page?.url();
    url = current && current !== 'about:blank' ? sessionFreeUrl(current) : undefined;
  } catch {
    url = undefined;
  }
  const blocked = session.context ? authenticatedConfinementBlocks(session.context) : undefined;
  return {
    phase: session.phase,
    url,
    blocked_requests: blocked?.count || undefined,
    blocked_hosts: blocked?.hosts.length ? blocked.hosts.join(',') : undefined,
    profile: source,
  };
}

async function inPhase<T>(
  session: Session,
  phase: string,
  source: string,
  work: () => Promise<T>
): Promise<T> {
  if (session.expired) throw new Error('[APPROVAL_QUEUE_DEADLINE] aborted');
  session.phase = phase;
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[APPROVAL_QUEUE_')) throw error;
    const [, code, next] = PHASE_HINTS.find(([pattern]) => pattern.test(phase)) ?? [
      undefined,
      'APPROVAL_QUEUE_RUN',
      'rerun with headless: false to watch the page',
    ];
    throw diagnostic(
      code,
      `${phase} failed`,
      safeCause(error),
      next,
      sessionEvidence(session, source)
    );
  }
}

function parseTotal(raw: string): number | undefined {
  const match = raw.match(/\d[\d,]*/);
  if (!match) return undefined;
  const value = Number(match[0].replace(/,/g, ''));
  return Number.isSafeInteger(value) ? value : undefined;
}

async function inspectSteps(
  profile: ApprovalQueueProfile,
  origin: string,
  headless: boolean,
  session: Session,
  source: string
): Promise<ApprovalQueueInspection> {
  const user = readCredential(profile, profile.credential.user_key, source);
  const password = readCredential(profile, profile.credential.password_key, source);
  const page = await inPhase(session, 'launch', source, async () => {
    const browser = await chromium.launch({
      headless,
      timeout: LAUNCH_TIMEOUT_MS,
      args: authenticatedOriginLaunchArgs(profile.origins),
    });
    session.browser = browser;
    if (session.expired) {
      await browser.close().catch(() => undefined);
      throw new Error('deadline reached during launch');
    }
    session.context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await installAuthenticatedOriginConfinement(session.context, profile.origins);
    const created = await session.context.newPage();
    created.setDefaultTimeout(ACTION_TIMEOUT_MS);
    session.page = created;
    return created;
  });
  await inPhase(session, 'login.open', source, () =>
    page.goto(profile.login.url, { waitUntil: 'load' })
  );
  await inPhase(session, 'login.fill', source, async () => {
    await fillSecret(page, profile.login.user_selector, user);
    await fillSecret(page, profile.login.password_selector, password);
  });
  await inPhase(session, 'login.submit', source, () =>
    guardedClick(page, 'login.submit_selector', profile.login.submit_selector)
  );
  await inPhase(session, 'login.confirm', source, async () => {
    const success = page.locator(profile.login.success_selector);
    const failure = profile.login.failure_selector
      ? page.locator(profile.login.failure_selector)
      : undefined;
    await (failure ? success.or(failure) : success).first().waitFor({ state: 'attached' });
    if (failure && (await success.count()) === 0)
      throw diagnostic(
        'APPROVAL_QUEUE_LOGIN_REJECTED',
        'Sign-in was rejected',
        'the system showed login.failure_selector',
        `update the secret with \`pnpm kyberion secret introduce ${profile.credential.service} ${normalizeSecretKey(profile.credential.password_key)}\``,
        sessionEvidence(session, source)
      );
  });
  for (const [index, step] of (profile.navigate ?? []).entries()) {
    const field = `navigate[${index}]`;
    await inPhase(session, field, source, async () => {
      if ('goto' in step) await page.goto(step.goto, { waitUntil: 'load' });
      else if ('click' in step) await guardedClick(page, field, step.click, step.has_text);
      else await page.locator(step.wait_for).first().waitFor({ state: 'attached' });
    });
  }
  // Apps often keep hidden row and "no data" templates in the page; only shown ones count.
  const rows = page.locator(profile.list.row_selector).filter({ visible: true });
  const empty = page.locator(profile.list.empty_selector).filter({ visible: true });
  await inPhase(session, 'list.ready', source, async () => {
    await page.locator(profile.list.ready_selector).first().waitFor({ state: 'attached' });
    await rows.or(empty).first().waitFor({ state: 'visible' });
  });
  return inPhase(session, 'list.extract', source, async () => {
    const limit = profile.list.max_items ?? DEFAULT_MAX_ITEMS;
    const snapshot = await rows.evaluateAll(
      (elements, args) => {
        const items: Array<Record<string, string>> = [];
        let misses = 0;
        let clipped = 0;
        let chars = 0;
        let sizeStop = false;
        for (const element of elements.slice(0, args.limit)) {
          const item: Record<string, string> = {};
          for (const [name, selector] of args.fields) {
            let node: Element | null = null;
            try {
              node = element.querySelector(selector);
            } catch {
              node = null;
            }
            if (!node) {
              misses += 1;
              item[name] = '';
              continue;
            }
            let value = ((node as HTMLElement).innerText || node.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (value.length > args.maxChars) {
              value = value.slice(0, args.maxChars);
              clipped += 1;
            }
            item[name] = value;
          }
          const size = JSON.stringify(item).length + 1;
          if (chars + size > args.maxItemsChars) {
            sizeStop = true;
            break;
          }
          chars += size;
          items.push(item);
        }
        return { rendered: elements.length, items, misses, clipped, sizeStop };
      },
      {
        fields: Object.entries(profile.list.fields ?? {}),
        limit,
        maxChars: MAX_VALUE_CHARS,
        maxItemsChars: MAX_ITEMS_CHARS,
      }
    );
    const fieldCount = Object.keys(profile.list.fields ?? {}).length;
    if (snapshot.rendered === 0 && (await empty.count()) === 0)
      throw diagnostic(
        'APPROVAL_QUEUE_LIST_INDETERMINATE',
        'No visible rows and no visible empty-state marker',
        'zero rows is only a result while list.empty_selector is visible',
        'check list.row_selector against the page',
        sessionEvidence(session, source)
      );
    if (
      fieldCount > 0 &&
      snapshot.items.length > 0 &&
      snapshot.misses === snapshot.items.length * fieldCount
    )
      throw diagnostic(
        'APPROVAL_QUEUE_LIST',
        'No field selector matched in any row',
        'list.fields selectors are CSS selectors relative to one row',
        'check list.fields against a row of the page',
        sessionEvidence(session, source)
      );
    let pendingCount = snapshot.rendered;
    let countBasis: ApprovalQueueInspection['count_basis'] = 'rendered_rows';
    if (profile.list.total_selector) {
      const totalText = await page
        .locator(profile.list.total_selector)
        .first()
        .innerText({ timeout: ACTION_TIMEOUT_MS });
      const total = parseTotal(totalText);
      if (total === undefined)
        throw diagnostic(
          'APPROVAL_QUEUE_LIST',
          'list.total_selector shows no number',
          `its text (${totalText.length} characters) contains no digits`,
          'point list.total_selector at the element with the pending total',
          sessionEvidence(session, source)
        );
      if (total < snapshot.rendered)
        throw diagnostic(
          'APPROVAL_QUEUE_LIST_INDETERMINATE',
          `list.total_selector reads ${total}, fewer than the ${snapshot.rendered} rows shown`,
          'the first number in that element is not the pending total',
          'point list.total_selector at an element that contains only the total',
          sessionEvidence(session, source)
        );
      pendingCount = total;
      countBasis = 'total_indicator';
    }
    const truncatedReason: ApprovalQueueInspection['truncated_reason'] = snapshot.sizeStop
      ? 'output_size'
      : snapshot.items.length < Math.min(snapshot.rendered, pendingCount)
        ? 'max_items'
        : pendingCount > snapshot.rendered
          ? 'not_rendered'
          : undefined;
    return {
      system: profile.system,
      origin,
      pending_count: pendingCount,
      count_basis: countBasis,
      rendered_rows: snapshot.rendered,
      items: snapshot.items,
      truncated: truncatedReason !== undefined,
      ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
      extraction_misses: snapshot.misses,
      clipped_values: snapshot.clipped,
      observed_at: new Date().toISOString(),
      final_url: sessionFreeUrl(page.url()),
    };
  });
}

export async function inspectInsideConfinement(
  profile: ApprovalQueueProfile,
  origin: string,
  headless: boolean,
  source = 'profile',
  deadlineMs = OPERATION_DEADLINE_MS
): Promise<ApprovalQueueInspection> {
  const session: Session = { phase: 'credential', expired: false };
  const work = inspectSteps(profile, origin, headless, session, source);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      session.expired = true;
      reject(
        diagnostic(
          'APPROVAL_QUEUE_DEADLINE',
          `Inspection did not finish within ${Math.round(deadlineMs / 1000)}s`,
          'the system was slow or a step kept waiting',
          'check the phase in the evidence; the next scheduled run starts fresh',
          sessionEvidence(session, source)
        )
      );
    }, deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined);
    await session.browser?.close().catch(() => undefined);
  }
}

function resolveProfilePath(raw: string, tenant: string): string {
  const absolute = pathResolver.rootResolve(raw);
  const root = pathResolver.rootResolve(`knowledge/confidential/${tenant}/approval-queues`);
  const relative = path.relative(root, absolute);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.extname(absolute) !== '.json'
  )
    throw diagnostic(
      'APPROVAL_QUEUE_PROFILE_PATH',
      `Profile ${describe(raw)} is outside this tenant's profiles`,
      'profiles are tenant-confidential and are read from one place only',
      `place it under knowledge/confidential/${tenant}/approval-queues/ as a .json file`
    );
  return absolute;
}

/** Reads and validates a tenant profile file; the hash is what a grant signs. */
export function loadApprovalQueueProfile(absolutePath: string): {
  profile: ApprovalQueueProfile;
  profileHash: string;
  relativePath: string;
} {
  const relativePath = path.relative(pathResolver.rootDir(), absolutePath);
  const content = String(safeReadFile(absolutePath, { encoding: 'utf8' }));
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw diagnostic(
      'APPROVAL_QUEUE_PROFILE',
      `${relativePath} is not valid JSON`,
      safeCause(error),
      'fix the JSON syntax'
    );
  }
  return {
    profile: parseApprovalQueueProfile(raw, relativePath),
    profileHash: approvalQueueProfileHash(content),
    relativePath,
  };
}

/** Reads one tenant approval queue. The whole login-and-read is one external
 * operation so a charter can delegate it by origin; raw clicks never can. */
export async function runApprovalQueueInspect(
  params: Record<string, unknown>,
  initialContext: Record<string, unknown>
) {
  const unknownKeys = Object.keys(params).filter((key) => !INPUT_KEYS.has(key));
  if (unknownKeys.length)
    throw diagnostic(
      'APPROVAL_QUEUE_INPUT',
      `Unsupported parameters: ${unknownKeys.join(', ')}`,
      'the step accepts profile, origin, headless and export_as',
      'remove the other parameters'
    );
  const tenant = (currentScopeEnvelope()?.identity ?? resolveScopeContext()).tenant_slug;
  if (!tenant)
    throw diagnostic(
      'APPROVAL_QUEUE_SCOPE',
      'No tenant is bound to this run',
      'profiles and credentials are tenant-scoped',
      'run the pipeline from the tenant (Chronos tenant pipeline or KYBERION_TENANT)'
    );
  if (typeof params.profile !== 'string' || !params.profile.trim())
    throw diagnostic(
      'APPROVAL_QUEUE_INPUT',
      'profile is required',
      'the step needs the profile file to run',
      `set profile to knowledge/confidential/${tenant}/approval-queues/<system>.json`
    );
  const { profile, profileHash, relativePath } = loadApprovalQueueProfile(
    resolveProfilePath(params.profile, tenant)
  );
  let origin = '';
  try {
    origin = normalizeConfinedOrigin(String(params.origin ?? ''));
  } catch {
    origin = '';
  }
  if (!origin || !profile.origins.includes(origin))
    throw diagnostic(
      'APPROVAL_QUEUE_INPUT',
      `origin ${describe(params.origin)} is not one of the profile origins`,
      'the step may only inspect an origin the profile declares',
      `set origin to one of ${profile.origins.join(', ')}`,
      { profile: relativePath }
    );
  const headless = params.headless !== false;
  const exportAs =
    typeof params.export_as === 'string' && params.export_as.trim()
      ? params.export_as.trim()
      : 'approval_queue';
  const inspection = await runExternalOperation(
    {
      operationId: OPERATION_ID,
      tenantSlug: tenant,
      effect: {
        navigation_confinement: AUTHENTICATED_ORIGIN_SET_CAPABILITY,
        origin,
        confined_origins: profile.origins,
        system: profile.system,
        profile_path: relativePath,
        profile_hash: profileHash,
        headless,
      },
      requiresApproval: true,
      delegable: isDelegableExternalOperation(OPERATION_ID),
      observationOnly: true,
    },
    () => inspectInsideConfinement(profile, origin, headless, relativePath),
    () => 'succeeded'
  );
  return {
    status: 'success' as const,
    results: [{ op: 'approval_queue_inspect', status: 'success', output: inspection }],
    context: { ...initialContext, [exportAs]: inspection },
    total_steps: 1,
  };
}
