/**
 * WI-05: consented PC-operation observation → content-free summary →
 * member-confirmed attachment to a work inventory entry.
 *
 * Flow (plan §2.3 ③, docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md):
 *
 *   reviewed recording (personal runtime)
 *     └─ summarizeRecordingForInventory   consent gate + review gate + integrity gate
 *          → ObservationSummary (pending_review)  personal tier:
 *            knowledge/personal/members/<member_id>/work-inventory/observations/<summary_id>.json
 *     └─ confirmObservationSummary         the member themself approves it
 *     └─ attachObservationToEntry          brokered personal → confidential crossing, audited
 *
 * Privacy invariants (enforced by construction — the digest is built from an
 * allowlist, never by copying and redacting):
 *   - NEVER copied: typed text, variable names/values, params, clipboard,
 *     window titles, URL paths/queries (browser: hostname only), selector
 *     descriptions/roles, accessible names, summaries, frame refs, recording
 *     file paths, recording/target names.
 *   - Copied: app names (only when the consent covers `active_window`),
 *     hostnames (only when it covers `browser_tabs`), coarse op kinds, counts,
 *     durations, and the recording hash.
 *   - Raw op strings are never copied either: unknown ops collapse to `other`.
 *
 * Review state: desktop recordings carry `review.status`; browser recordings
 * carry an optional `review` with the same `approved` state (plus per-action
 * decisions). Both must be `approved`; for browser recordings only actions
 * whose decision is not `rejected` are counted.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import { auditChain } from './audit-chain.js';
import { humanActor } from './actor.js';
import { compileSchema } from './foundation/ajv.js';
import { nowIso } from './foundation/time.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { validateDesktopRecording, type DesktopRecording } from './desktop-recording.js';
import {
  validateBrowserExtensionRecording,
  type BrowserExtensionRecording,
} from './browser-extension-bridge.js';
import {
  applyClassification,
  loadWorkInventoryTaxonomy,
  type WorkEffect,
  type WorkInventoryEntry,
  type WorkInventoryObservation,
  type WorkInventoryStep,
  type WorkStage,
  type WorkVerb,
} from './work-inventory.js';
import {
  evaluateConsentCoverage,
  listWorkInventoryConsents,
  memberWorkInventoryRoot,
  WorkInventoryConsentError,
  type WorkInventoryConsentSource,
  type WorkInventoryHumanActor,
  type WorkInventoryObservationKind,
} from './work-inventory-consent.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObservationOpKind =
  | 'click'
  | 'select'
  | 'drag'
  | 'input'
  | 'navigate'
  | 'open'
  | 'close'
  | 'copy'
  | 'paste'
  | 'download'
  | 'save'
  | 'upload'
  | 'send'
  | 'submit'
  | 'delete'
  | 'purchase'
  | 'credential'
  | 'settings'
  | 'observe'
  | 'other';

export type ObservationSummaryVerb = Extract<
  WorkVerb,
  'read' | 'input' | 'transform' | 'operate' | 'communicate' | 'record'
>;

export interface ObservationProposedStep {
  stage: WorkStage;
  verb: ObservationSummaryVerb;
  /** Generic, built from the verb phrase + app/host name ONLY (e.g. "operate in Excel"). */
  description: string;
  system?: string;
  effects: WorkEffect[];
  /** True for ops that send, pay, delete, or change settings — the member must look at these. */
  requires_attention: boolean;
}

export type ObservationSummaryStatus = 'pending_review' | 'confirmed' | 'discarded';

export interface WorkInventoryObservationSummary {
  schema_version: 'work-inventory-observation-summary.v1';
  summary_id: string;
  member_id: string;
  tenant_slug?: string;
  consent_id: string;
  source: WorkInventoryConsentSource;
  recording_hash: string;
  window: { start: string; end: string };
  /** Application names only (requires the `active_window` observation kind). */
  apps: string[];
  /** Hostnames only — never paths or queries (requires the `browser_tabs` observation kind). */
  hosts: string[];
  op_counts: Partial<Record<ObservationOpKind, number>>;
  step_count: number;
  duration_ms?: number;
  proposed_steps: ObservationProposedStep[];
  status: ObservationSummaryStatus;
  created_at: string;
  confirmed_at?: string;
  confirmed_by?: WorkInventoryHumanActor;
  discarded_at?: string;
  discarded_by?: WorkInventoryHumanActor;
}

export type InventoryRecording = DesktopRecording | BrowserExtensionRecording;

// ---------------------------------------------------------------------------
// Op-kind and verb tables (deterministic; documented here on purpose)
// ---------------------------------------------------------------------------

/**
 * Raw recording op → coarse op kind. Anything not listed becomes `other`, so a
 * free-form op string in a recording can never reach the summary.
 *
 * desktop-recording ops: see RECORDED_EVENT_OPS / RECORDED_OP_ALIASES in desktop-recording.ts.
 * browser-recording ops: see BrowserExtensionOperation in browser-extension-bridge.ts.
 */
const OP_KIND_BY_RAW_OP: Readonly<Record<string, ObservationOpKind>> = {
  // desktop
  mouse_click: 'click',
  click_at: 'click',
  click_element: 'click',
  right_click: 'click',
  right_click_at: 'click',
  keyboard: 'input',
  keystroke_text: 'input',
  press_key: 'input',
  type_text: 'input',
  paste_text: 'paste',
  copy_text: 'copy',
  drag: 'drag',
  activate_application: 'open',
  activate_window_by_title: 'open',
  app_quit: 'close',
  process_kill: 'close',
  delete: 'delete',
  submit: 'submit',
  save: 'save',
  screenshot: 'observe',
  get_focused_input: 'observe',
  window_list: 'observe',
  clipboard_read: 'observe',
  chrome_tab_list: 'observe',
  wait_for_element: 'observe',
  // browser
  click_ref: 'click',
  click_if_present: 'click',
  press_ref: 'click',
  select_ref: 'select',
  select_tab: 'select',
  fill_ref: 'input',
  sensitive_input_omitted: 'input',
  navigate: 'navigate',
  open_tab: 'open',
  submit_form: 'submit',
  upload_file: 'upload',
  download_file: 'download',
  purchase: 'purchase',
  credential_submit: 'credential',
  settings_change: 'settings',
  snapshot: 'observe',
  extract_text_ref: 'observe',
  list_tabs: 'observe',
  wait_for_ref: 'observe',
};

/**
 * Coarse op kind → proposed verb + effects. `null` = not a unit of work
 * (pure observation / unknown); counted in op_counts, never proposed as a step.
 *
 * | op kind                        | verb        | effects          | attention |
 * | ------------------------------ | ----------- | ---------------- | --------- |
 * | click, select, drag            | operate     | -                | no        |
 * | navigate, open, close          | operate     | -                | no        |
 * | input                          | input       | -                | no        |
 * | copy, paste                    | transform   | -                | no        |
 * | download, save                 | record      | -                | no        |
 * | send, submit, upload           | communicate | external_send    | yes       |
 * | credential                     | communicate | personal_data    | yes       |
 * | delete, settings               | operate     | irreversible     | yes       |
 * | purchase                       | operate     | money            | yes       |
 * | observe, other                 | (none)      |                  |           |
 */
const VERB_BY_OP_KIND: Readonly<
  Record<ObservationOpKind, { verb: ObservationSummaryVerb; effects: WorkEffect[] } | null>
> = {
  click: { verb: 'operate', effects: [] },
  select: { verb: 'operate', effects: [] },
  drag: { verb: 'operate', effects: [] },
  navigate: { verb: 'operate', effects: [] },
  open: { verb: 'operate', effects: [] },
  close: { verb: 'operate', effects: [] },
  input: { verb: 'input', effects: [] },
  copy: { verb: 'transform', effects: [] },
  paste: { verb: 'transform', effects: [] },
  download: { verb: 'record', effects: [] },
  save: { verb: 'record', effects: [] },
  send: { verb: 'communicate', effects: ['external_send'] },
  submit: { verb: 'communicate', effects: ['external_send'] },
  upload: { verb: 'communicate', effects: ['external_send'] },
  credential: { verb: 'communicate', effects: ['personal_data'] },
  delete: { verb: 'operate', effects: ['irreversible'] },
  settings: { verb: 'operate', effects: ['irreversible'] },
  purchase: { verb: 'operate', effects: ['money'] },
  observe: null,
  other: null,
};

const VERB_PHRASE: Readonly<Record<ObservationSummaryVerb, string>> = {
  read: 'read',
  operate: 'operate',
  input: 'enter data',
  transform: 'copy and paste data',
  record: 'save or download',
  communicate: 'send or submit',
};

export function opKindFor(rawOp: string): ObservationOpKind {
  return Object.prototype.hasOwnProperty.call(OP_KIND_BY_RAW_OP, rawOp)
    ? OP_KIND_BY_RAW_OP[rawOp]
    : 'other';
}

const MAX_PROPOSED_STEPS = 50;
const APP_NAME_PATTERN = /^[\p{L}\p{N} ._()&+-]{1,80}$/u;
const HOSTNAME_PATTERN = /^[a-z0-9.-]{1,253}$/;
const SUMMARY_ID_PATTERN = /^WIO-\d{8}-[a-f0-9]{12}$/;

function safeAppName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return APP_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Hostname only: `https://mail.example.com/inbox?q=x` → `mail.example.com`. */
export function hostnameOnly(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return undefined;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return HOSTNAME_PATTERN.test(host) ? host : undefined;
}

// ---------------------------------------------------------------------------
// Pure digest (allowlist extraction)
// ---------------------------------------------------------------------------

interface ObservedUnit {
  kind: ObservationOpKind;
  system?: string;
}

export interface ObservationDigest {
  source: WorkInventoryConsentSource;
  apps: string[];
  hosts: string[];
  op_counts: Partial<Record<ObservationOpKind, number>>;
  step_count: number;
  duration_ms?: number;
  window: { start: string; end: string };
  proposed_steps: ObservationProposedStep[];
}

function isBrowserRecording(recording: InventoryRecording): recording is BrowserExtensionRecording {
  return recording.schema_version === 'browser-recording.v1';
}

export function recordingSourceOf(recording: InventoryRecording): WorkInventoryConsentSource {
  return isBrowserRecording(recording) ? 'browser_recording' : 'desktop_recording';
}

function desktopUnits(
  recording: DesktopRecording,
  kinds: ReadonlySet<WorkInventoryObservationKind>
): { units: ObservedUnit[]; apps: string[]; hosts: string[] } {
  const apps = new Set<string>();
  const hosts = new Set<string>();
  const units: ObservedUnit[] = [];
  const fallbackApp = kinds.has('active_window') ? safeAppName(recording.target?.app) : undefined;
  for (const step of recording.steps ?? []) {
    const app = kinds.has('active_window') ? safeAppName(step.selector?.app) : undefined;
    let host: string | undefined;
    if (kinds.has('browser_tabs')) {
      const evidence = (step.evidence ?? []).find(
        (item) => typeof item === 'string' && item.startsWith('browser_tabs:host:')
      );
      host = evidence ? hostnameOnly(evidence.slice('browser_tabs:host:'.length)) : undefined;
    }
    if (app) apps.add(app);
    if (host) hosts.add(host);
    units.push({ kind: opKindFor(String(step.op)), system: app ?? host ?? fallbackApp });
  }
  if (fallbackApp && units.length > 0) apps.add(fallbackApp);
  return { units, apps: [...apps], hosts: [...hosts] };
}

function browserUnits(
  recording: BrowserExtensionRecording,
  kinds: ReadonlySet<WorkInventoryObservationKind>
): { units: ObservedUnit[]; hosts: string[]; times: number[] } {
  const hosts = new Set<string>();
  const units: ObservedUnit[] = [];
  const times: number[] = [];
  const rejected = new Set(
    (recording.review?.decisions ?? [])
      .filter((decision) => decision.status === 'rejected')
      .map((decision) => decision.action_id)
  );
  let currentHost = kinds.has('browser_tabs') ? hostnameOnly(recording.tab?.origin) : undefined;
  if (currentHost) hosts.add(currentHost);
  for (const action of recording.actions ?? []) {
    if (action.op === 'navigate' && kinds.has('browser_tabs')) {
      const next = hostnameOnly(action.navigation?.to_origin);
      if (next) {
        currentHost = next;
        hosts.add(next);
      }
    }
    if (rejected.has(action.action_id)) continue;
    const at = Date.parse(action.captured_at);
    if (Number.isFinite(at)) times.push(at);
    units.push({ kind: opKindFor(String(action.op)), system: currentHost });
  }
  return { units, hosts: [...hosts], times };
}

function proposeSteps(
  units: readonly ObservedUnit[],
  source: WorkInventoryConsentSource
): ObservationProposedStep[] {
  const taxonomy = loadWorkInventoryTaxonomy();
  const stageOf = (verb: WorkVerb): WorkStage =>
    taxonomy.verbs.find((def) => def.id === verb)?.default_stage ?? 'act';
  const where = source === 'browser_recording' ? 'the browser' : 'a desktop application';
  const steps: ObservationProposedStep[] = [];
  let previousKey = '';
  for (const unit of units) {
    const mapped = VERB_BY_OP_KIND[unit.kind];
    if (!mapped) continue;
    const key = `${mapped.verb}|${unit.system ?? ''}|${mapped.effects.join(',')}`;
    if (key === previousKey) continue; // collapse consecutive repeats into one step
    previousKey = key;
    if (steps.length >= MAX_PROPOSED_STEPS) break;
    steps.push({
      stage: stageOf(mapped.verb),
      verb: mapped.verb,
      description: `${VERB_PHRASE[mapped.verb]} in ${unit.system ?? where}`,
      ...(unit.system ? { system: unit.system } : {}),
      effects: [...mapped.effects],
      requires_attention: mapped.effects.length > 0,
    });
  }
  return steps;
}

/**
 * Pure, allowlist-only digest of a recording. Reads op strings, app names,
 * hostnames, timestamps, and review decisions — nothing else — and is safe
 * to call on hostile (unvalidated) input.
 */
export function deriveObservationDigest(
  recording: InventoryRecording,
  observationKinds: readonly WorkInventoryObservationKind[]
): ObservationDigest {
  const kinds = new Set(observationKinds);
  const source = recordingSourceOf(recording);
  const createdAt = Date.parse(recording.created_at);
  let units: ObservedUnit[];
  let apps: string[] = [];
  let hosts: string[];
  let times: number[] = [];
  if (isBrowserRecording(recording)) {
    ({ units, hosts, times } = browserUnits(recording, kinds));
  } else {
    ({ units, apps, hosts } = desktopUnits(recording, kinds));
  }
  const opCounts: Partial<Record<ObservationOpKind, number>> = {};
  for (const unit of units) opCounts[unit.kind] = (opCounts[unit.kind] ?? 0) + 1;
  const allTimes = [...times, ...(Number.isFinite(createdAt) ? [createdAt] : [])];
  const start = allTimes.length > 0 ? Math.min(...allTimes) : Date.now();
  const end = allTimes.length > 0 ? Math.max(...allTimes) : start;
  const duration = times.length >= 2 ? Math.max(...times) - Math.min(...times) : undefined;
  return {
    source,
    apps: apps.sort(),
    hosts: hosts.sort(),
    op_counts: opCounts,
    step_count: units.length,
    ...(duration !== undefined ? { duration_ms: duration } : {}),
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    proposed_steps: proposeSteps(units, source),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Desktop: the recording's own (validated) hash. Browser: sha256 of canonical JSON minus `review`. */
export function inventoryRecordingHash(recording: InventoryRecording): string {
  if (!isBrowserRecording(recording)) return recording.recording_hash;
  const { review: _review, ...body } = recording;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

// ---------------------------------------------------------------------------
// Schema validation + storage
// ---------------------------------------------------------------------------

const SUMMARY_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/work-inventory-observation-summary.schema.json'
);
let summaryValidator: ValidateFunction<WorkInventoryObservationSummary> | undefined;

export function validateObservationSummary(input: unknown): { valid: boolean; errors: string[] } {
  summaryValidator ||= compileSchema<WorkInventoryObservationSummary>(SUMMARY_SCHEMA_PATH);
  if (summaryValidator(input)) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (summaryValidator.errors || []).map((error) =>
      `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
    ),
  };
}

export function observationSummaryPath(
  memberId: string,
  summaryId: string,
  rootDir: string = pathResolver.rootDir()
): string {
  if (!SUMMARY_ID_PATTERN.test(summaryId)) {
    throw new WorkInventoryConsentError('invalid_input', `invalid summary id: ${summaryId}`);
  }
  const candidate = path.join(
    memberWorkInventoryRoot(memberId, rootDir),
    'observations',
    `${summaryId}.json`
  );
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true, rootDir });
}

function writeSummary(summary: WorkInventoryObservationSummary, rootDir: string): void {
  const check = validateObservationSummary(summary);
  if (!check.valid) {
    throw new WorkInventoryConsentError(
      'invalid_input',
      `invalid observation summary ${summary.summary_id}: ${check.errors.join('; ')}`
    );
  }
  const filePath = observationSummaryPath(summary.member_id, summary.summary_id, rootDir);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8' });
}

export function loadObservationSummary(
  memberId: string,
  summaryId: string,
  options: { rootDir?: string } = {}
): WorkInventoryObservationSummary | null {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const filePath = observationSummaryPath(memberId, summaryId, rootDir);
  if (!safeExistsSync(filePath)) return null;
  const raw = parseSafeJsonInput(
    String(safeReadFile(filePath, { encoding: 'utf8' })),
    `observation summary ${summaryId}`
  );
  const check = validateObservationSummary(raw);
  if (!check.valid) {
    throw new WorkInventoryConsentError(
      'invalid_state',
      `stored observation summary ${summaryId} is invalid: ${check.errors.join('; ')}`
    );
  }
  const summary = raw as WorkInventoryObservationSummary;
  if (summary.member_id !== memberId || summary.summary_id !== summaryId) {
    throw new WorkInventoryConsentError(
      'invalid_state',
      `stored observation summary ${summaryId} does not belong to ${memberId}`
    );
  }
  return summary;
}

export function listObservationSummaries(
  memberId: string,
  options: { rootDir?: string } = {}
): WorkInventoryObservationSummary[] {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const dir = path.join(memberWorkInventoryRoot(memberId, rootDir), 'observations');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .filter((id) => SUMMARY_ID_PATTERN.test(id))
    .map((id) => loadObservationSummary(memberId, id, { rootDir }))
    .filter((summary): summary is WorkInventoryObservationSummary => Boolean(summary))
    .sort((a, b) => a.summary_id.localeCompare(b.summary_id));
}

// ---------------------------------------------------------------------------
// Summarize (consent gate + review gate + integrity gate)
// ---------------------------------------------------------------------------

export interface SummarizeRecordingOptions {
  member_id: string;
  tenant_slug?: string;
  now?: Date;
  rootDir?: string;
}

function assertRecordingReviewed(recording: InventoryRecording): void {
  // Both recording kinds expose review.status with an explicit 'approved' state.
  if (recording.review?.status !== 'approved') {
    throw new WorkInventoryConsentError(
      'recording_not_reviewed',
      `recording ${String(recording.recording_id)} is not approved by review (status: ${
        recording.review?.status ?? 'none'
      })`
    );
  }
}

function assertRecordingIntegrity(recording: InventoryRecording): void {
  const result = isBrowserRecording(recording)
    ? validateBrowserExtensionRecording(recording)
    : validateDesktopRecording(recording);
  if (!result.valid) {
    throw new WorkInventoryConsentError(
      'invalid_recording',
      `recording failed contract validation (${result.errors.length} error(s))`
    );
  }
}

/** Keyed on the recording (not on when it was summarized) so re-summarizing never duplicates. */
function summaryIdFor(
  memberId: string,
  consentId: string,
  recordingHash: string,
  recordedAt: Date
) {
  const datePart = recordedAt.toISOString().slice(0, 10).replaceAll('-', '');
  const digest = createHash('sha256')
    .update(`${memberId}|${consentId}|${recordingHash}`)
    .digest('hex')
    .slice(0, 12);
  return `WIO-${datePart}-${digest}`;
}

/**
 * Build and store a `pending_review` summary of one recording, only if a
 * single consent of the member covers the recording's source across the whole
 * recording window AND at `now`, and the recording passed human review.
 * Throws {@link WorkInventoryConsentError} otherwise — nothing is written.
 */
export function summarizeRecordingForInventory(
  recording: InventoryRecording,
  options: SummarizeRecordingOptions
): WorkInventoryObservationSummary {
  const now = options.now ?? new Date();
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const memberId = options.member_id;
  memberWorkInventoryRoot(memberId, rootDir); // validates the member id segment
  if (!recording || typeof recording !== 'object') {
    throw new WorkInventoryConsentError('invalid_recording', 'recording is required');
  }
  const source = recordingSourceOf(recording);

  // 1. Consent gate — decided before any recording content is looked at.
  //    Only timestamps are read here.
  const createdAt = new Date(recording.created_at);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new WorkInventoryConsentError('invalid_recording', 'recording.created_at is not a date');
  }
  const windowInstants = [createdAt];
  if (isBrowserRecording(recording)) {
    for (const action of recording.actions ?? []) {
      const at = new Date(action.captured_at);
      if (Number.isFinite(at.getTime())) windowInstants.push(at);
    }
  }
  const earliest = new Date(Math.min(...windowInstants.map((d) => d.getTime())));
  const latest = new Date(Math.max(...windowInstants.map((d) => d.getTime())));
  const coverage = evaluateConsentCoverage(
    listWorkInventoryConsents(memberId, { rootDir }),
    source,
    [earliest, latest, now],
    options.tenant_slug
  );
  if ('code' in coverage) throw new WorkInventoryConsentError(coverage.code, coverage.reason);
  const consent = coverage.consent;

  // 2. Review gate + 3. integrity gate.
  assertRecordingReviewed(recording);
  assertRecordingIntegrity(recording);

  // 4. Allowlist digest.
  const digest = deriveObservationDigest(recording, consent.observation_kinds);
  const recordingHash = inventoryRecordingHash(recording);
  const tenantSlug = options.tenant_slug ?? consent.tenant_slug;
  const summaryId = summaryIdFor(memberId, consent.consent_id, recordingHash, createdAt);

  const existing = loadObservationSummary(memberId, summaryId, { rootDir });
  if (existing) return existing; // idempotent: never overwrite a confirmed/discarded decision

  const summary: WorkInventoryObservationSummary = {
    schema_version: 'work-inventory-observation-summary.v1',
    summary_id: summaryId,
    member_id: memberId,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    consent_id: consent.consent_id,
    source,
    recording_hash: recordingHash,
    window: digest.window,
    apps: digest.apps,
    hosts: digest.hosts,
    op_counts: digest.op_counts,
    step_count: digest.step_count,
    ...(digest.duration_ms !== undefined ? { duration_ms: digest.duration_ms } : {}),
    proposed_steps: digest.proposed_steps,
    status: 'pending_review',
    created_at: nowIso(now),
  };
  auditChain.record({
    agentId: `user:${memberId}`,
    actor: humanActor(memberId),
    action: 'work_inventory.observation_summarized',
    operation: summaryId,
    result: 'completed',
    ...(tenantSlug ? { tenantSlug } : {}),
    metadata: {
      member_id: memberId,
      summary_id: summaryId,
      consent_id: consent.consent_id,
      source,
      recording_hash: recordingHash,
      step_count: summary.step_count,
    },
  });
  writeSummary(summary, rootDir);
  return summary;
}

// ---------------------------------------------------------------------------
// Member decisions on a summary
// ---------------------------------------------------------------------------

export interface SummaryDecisionOptions {
  by: WorkInventoryHumanActor;
  now?: Date;
  rootDir?: string;
}

function assertSubject(by: WorkInventoryHumanActor | undefined, memberId: string, what: string) {
  if (!by || by.kind !== 'human' || by.id !== memberId) {
    throw new WorkInventoryConsentError(
      'not_subject',
      `${what} must be performed by the member themself (${memberId})`
    );
  }
}

function decideSummary(
  memberId: string,
  summaryId: string,
  decision: 'confirmed' | 'discarded',
  options: SummaryDecisionOptions
): WorkInventoryObservationSummary {
  const now = options.now ?? new Date();
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  assertSubject(
    options.by,
    memberId,
    `${decision === 'confirmed' ? 'confirming' : 'discarding'} an observation summary`
  );
  const existing = loadObservationSummary(memberId, summaryId, { rootDir });
  if (!existing) {
    throw new WorkInventoryConsentError('not_found', `observation summary ${summaryId} not found`);
  }
  if (existing.status !== 'pending_review') {
    throw new WorkInventoryConsentError(
      'invalid_state',
      `observation summary ${summaryId} is already ${existing.status}`
    );
  }
  const by = { kind: 'human' as const, id: options.by.id };
  const updated: WorkInventoryObservationSummary =
    decision === 'confirmed'
      ? { ...existing, status: 'confirmed', confirmed_at: nowIso(now), confirmed_by: by }
      : { ...existing, status: 'discarded', discarded_at: nowIso(now), discarded_by: by };
  auditChain.record({
    agentId: `user:${memberId}`,
    actor: humanActor(memberId),
    action: `work_inventory.observation_${decision}`,
    operation: summaryId,
    result: 'completed',
    ...(existing.tenant_slug ? { tenantSlug: existing.tenant_slug } : {}),
    metadata: { member_id: memberId, summary_id: summaryId, consent_id: existing.consent_id },
  });
  writeSummary(updated, rootDir);
  return updated;
}

/** Only the member themself can confirm their summary. */
export function confirmObservationSummary(
  memberId: string,
  summaryId: string,
  options: SummaryDecisionOptions
): WorkInventoryObservationSummary {
  return decideSummary(memberId, summaryId, 'confirmed', options);
}

/** Only the member themself can discard their summary. */
export function discardObservationSummary(
  memberId: string,
  summaryId: string,
  options: SummaryDecisionOptions
): WorkInventoryObservationSummary {
  return decideSummary(memberId, summaryId, 'discarded', options);
}

// ---------------------------------------------------------------------------
// Attach (brokered personal → confidential crossing)
// ---------------------------------------------------------------------------

function formatMinutes(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} min`;
}

/** e.g. "38 ops in Excel, Chrome over 12 min" — counts and names only. */
export function observationDigestLine(summary: WorkInventoryObservationSummary): string {
  const places = [...summary.apps, ...summary.hosts];
  const shown = places.slice(0, 3).join(', ');
  const more = places.length > 3 ? ` +${places.length - 3}` : '';
  const where = places.length > 0 ? ` in ${shown}${more}` : '';
  const over =
    summary.duration_ms !== undefined ? ` over ${formatMinutes(summary.duration_ms)}` : '';
  return `${summary.step_count} ops${where}${over}`;
}

export interface AttachObservationOptions {
  by: WorkInventoryHumanActor;
  now?: Date;
  /** Where the member's stored (authoritative) summary is read from. */
  rootDir?: string;
  apiSystems?: string[];
}

/**
 * Attach a member-confirmed summary to an inventory entry and return the new
 * entry (the caller persists it). The stored summary in the member's personal
 * tier is authoritative: the in-memory `summary` must match it, and it must be
 * `confirmed`. The crossing is audited before the entry is returned.
 */
export function attachObservationToEntry(
  entry: WorkInventoryEntry,
  summary: WorkInventoryObservationSummary,
  options: AttachObservationOptions
): WorkInventoryEntry {
  const now = options.now ?? new Date();
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  assertSubject(options.by, summary.member_id, 'attaching an observation summary');
  const stored = loadObservationSummary(summary.member_id, summary.summary_id, { rootDir });
  if (!stored) {
    throw new WorkInventoryConsentError(
      'not_found',
      `observation summary ${summary.summary_id} not found`
    );
  }
  if (stored.status !== 'confirmed' || summary.status !== 'confirmed') {
    throw new WorkInventoryConsentError(
      'invalid_state',
      `observation summary ${summary.summary_id} must be confirmed by the member before attaching`
    );
  }
  if (
    stored.recording_hash !== summary.recording_hash ||
    stored.consent_id !== summary.consent_id
  ) {
    throw new WorkInventoryConsentError(
      'invalid_state',
      `observation summary ${summary.summary_id} does not match the stored record`
    );
  }
  const entryTenant = entry.scope?.tenant_slug;
  if (entryTenant && entryTenant !== stored.tenant_slug) {
    throw new WorkInventoryConsentError(
      'tenant_mismatch',
      `summary tenant ${stored.tenant_slug ?? '(none)'} does not match entry tenant ${entryTenant}`
    );
  }
  const ref = `observation:${stored.summary_id}`;
  if ((entry.observations ?? []).some((observation) => observation.ref === ref)) {
    throw new WorkInventoryConsentError(
      'invalid_state',
      `${ref} is already attached to ${entry.entry_id}`
    );
  }

  const observation: WorkInventoryObservation = {
    source: stored.source,
    ref,
    observed_at: stored.window.end,
    digest: observationDigestLine(stored),
    metrics: {
      count: stored.step_count,
      ...(stored.duration_ms !== undefined ? { median_duration_ms: stored.duration_ms } : {}),
    },
  };
  const seededSteps: WorkInventoryStep[] =
    entry.steps.length > 0
      ? entry.steps
      : stored.proposed_steps.map((proposed, index) => ({
          step_id: `S${index + 1}`,
          stage: proposed.stage,
          verb: proposed.verb,
          description: proposed.description,
          ...(proposed.system ? { system: proposed.system } : {}),
          data_sensitivity: 'internal',
          effects: [...proposed.effects],
          method: {
            assigned: 'human',
            source: 'proposal',
            rationale: `seeded from ${ref}`,
          },
        }));
  const next = applyClassification(
    {
      ...entry,
      steps: seededSteps,
      observations: [...(entry.observations ?? []), observation],
      updated_at: nowIso(now),
    },
    { apiSystems: options.apiSystems }
  );

  auditChain.record({
    agentId: `user:${stored.member_id}`,
    actor: humanActor(stored.member_id),
    action: 'work_inventory.observation_attached',
    operation: stored.summary_id,
    result: 'completed',
    ...(entryTenant ? { tenantSlug: entryTenant } : {}),
    metadata: {
      member_id: stored.member_id,
      summary_id: stored.summary_id,
      consent_id: stored.consent_id,
      entry_id: entry.entry_id,
      tenant_slug: entryTenant ?? null,
      from_tier: 'personal',
      to_tier: entryTenant ? 'confidential' : 'personal',
      seeded_steps: entry.steps.length === 0 ? seededSteps.length : 0,
    },
  });
  return next;
}
