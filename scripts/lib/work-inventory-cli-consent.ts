/**
 * WI-07: `pnpm inventory consent ...` and `pnpm inventory observe ...`
 * command handlers.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { loadDesktopRecordingAtPath } from '@agent/core/desktop-recording';
import { loadBrowserExtensionRecordingAtPath } from '@agent/core/browser-extension-bridge';
import {
  loadWorkInventoryEntry,
  saveWorkInventoryEntry,
  type WorkInventoryEntry,
} from '@agent/core/work-inventory';
import {
  grantWorkInventoryConsent,
  listWorkInventoryConsents,
  revokeWorkInventoryConsent,
  type WorkInventoryConsent,
  type WorkInventoryConsentSource,
  type WorkInventoryObservationKind,
} from '@agent/core/work-inventory-consent';
import {
  attachObservationToEntry,
  confirmObservationSummary,
  discardObservationSummary,
  listObservationSummaries,
  loadObservationSummary,
  observationDigestLine,
  summarizeRecordingForInventory,
  type InventoryRecording,
  type WorkInventoryObservationSummary,
} from '@agent/core/work-inventory-observation';
import { readSafeJsonValueFile } from './json-input.js';
import {
  bareMemberId,
  csv,
  formatTable,
  requireDecidedBy,
  requireFlag,
  resolveScope,
} from './work-inventory-cli-shared.js';
import type { WorkInventoryCliOptions } from './work-inventory-cli-entries.js';

// ---------------------------------------------------------------------------
// consent
// ---------------------------------------------------------------------------

export function runConsentGrant(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryConsent {
  const memberId = requireFlag(argv, '--member', 'consent grant');
  const sources = csv(argv, '--sources') as WorkInventoryConsentSource[];
  const kinds = csv(argv, '--kinds') as WorkInventoryObservationKind[];
  const purpose = requireFlag(argv, '--purpose', 'consent grant');
  const daysRaw = requireFlag(argv, '--days', 'consent grant');
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days must be a positive number, got "${daysRaw}"`);
  }
  const decidedBy = requireDecidedBy(argv);
  const scope = resolveScope(argv);
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  return grantWorkInventoryConsent(
    {
      member_id: memberId,
      ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
      sources,
      observation_kinds: kinds,
      purpose,
      expires_at: expiresAt,
      granted_by: { kind: 'human', id: bareMemberId(decidedBy) },
    },
    { rootDir: options.rootDir, now }
  );
}

export function runConsentRevoke(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryConsent {
  const memberId = requireFlag(argv, '--member', 'consent revoke');
  const consentId = requireFlag(argv, '--consent', 'consent revoke');
  const decidedBy = requireDecidedBy(argv);
  return revokeWorkInventoryConsent(memberId, consentId, {
    rootDir: options.rootDir,
    now: options.now,
    by: { kind: 'human', id: bareMemberId(decidedBy) },
  });
}

export function runConsentList(
  argv: string[],
  options: WorkInventoryCliOptions
): WorkInventoryConsent[] {
  const memberId = requireFlag(argv, '--member', 'consent list');
  return listWorkInventoryConsents(memberId, { rootDir: options.rootDir });
}

export function formatConsent(consent: WorkInventoryConsent): string {
  return [
    `${consent.consent_id}  member=${consent.member_id}`,
    `sources: ${consent.sources.join(', ')}`,
    `observation_kinds: ${consent.observation_kinds.join(', ')}`,
    `granted_at: ${consent.granted_at}  expires_at: ${consent.expires_at}`,
    consent.revoked_at ? `revoked_at: ${consent.revoked_at}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function formatConsentList(consents: readonly WorkInventoryConsent[]): string {
  return formatTable(
    ['consent_id', 'sources', 'kinds', 'granted_at', 'expires_at', 'revoked_at'],
    consents.map((consent) => [
      consent.consent_id,
      consent.sources.join(','),
      consent.observation_kinds.join(','),
      consent.granted_at,
      consent.expires_at,
      consent.revoked_at ?? '',
    ])
  );
}

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

const RECORDINGS_ROOT_SEGMENTS = ['active', 'shared', 'runtime', 'recordings'];

/** Resolves and bounds a recording path to `active/shared/runtime/recordings/` under the repo. */
export function resolveRecordingPath(recordingPath: string, rootDir: string): string {
  const candidate = path.isAbsolute(recordingPath)
    ? recordingPath
    : path.join(rootDir, recordingPath);
  // The boundary check must run before existence is checked — a path outside
  // active/shared/runtime/recordings/ must never leak whether a file exists
  // there. Existence is verified afterwards by the recording loader itself.
  const safePath = assertSafeRepositoryPath(candidate, { rootDir, allowMissingLeaf: true });
  const boundary = path.join(rootDir, ...RECORDINGS_ROOT_SEGMENTS) + path.sep;
  if (!safePath.startsWith(boundary)) {
    throw new Error(
      `--recording must be under ${RECORDINGS_ROOT_SEGMENTS.join('/')}/: ${recordingPath}`
    );
  }
  return safePath;
}

function loadInventoryRecording(safePath: string): InventoryRecording {
  const peek = readSafeJsonValueFile<{ schema_version?: string }>(
    safePath,
    'work inventory recording'
  );
  if (peek.schema_version === 'browser-recording.v1') {
    return loadBrowserExtensionRecordingAtPath(safePath);
  }
  return loadDesktopRecordingAtPath(safePath);
}

export function runObserveSummarize(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryObservationSummary {
  const memberId = requireFlag(argv, '--member', 'observe summarize');
  const recordingArg = requireFlag(argv, '--recording', 'observe summarize');
  const scope = resolveScope(argv);
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const safePath = resolveRecordingPath(recordingArg, rootDir);
  const recording = loadInventoryRecording(safePath);
  return summarizeRecordingForInventory(recording, {
    member_id: memberId,
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    now: options.now,
    rootDir,
  });
}

export function runObserveConfirm(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryObservationSummary {
  const memberId = requireFlag(argv, '--member', 'observe confirm');
  const summaryId = requireFlag(argv, '--summary', 'observe confirm');
  const decidedBy = requireDecidedBy(argv);
  return confirmObservationSummary(memberId, summaryId, {
    rootDir: options.rootDir,
    now: options.now,
    by: { kind: 'human', id: bareMemberId(decidedBy) },
  });
}

export function runObserveDiscard(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryObservationSummary {
  const memberId = requireFlag(argv, '--member', 'observe discard');
  const summaryId = requireFlag(argv, '--summary', 'observe discard');
  const decidedBy = requireDecidedBy(argv);
  return discardObservationSummary(memberId, summaryId, {
    rootDir: options.rootDir,
    now: options.now,
    by: { kind: 'human', id: bareMemberId(decidedBy) },
  });
}

export function runObserveList(
  argv: string[],
  options: WorkInventoryCliOptions
): WorkInventoryObservationSummary[] {
  const memberId = requireFlag(argv, '--member', 'observe list');
  return listObservationSummaries(memberId, { rootDir: options.rootDir });
}

export function runObserveAttach(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryEntry {
  const memberId = requireFlag(argv, '--member', 'observe attach');
  const summaryId = requireFlag(argv, '--summary', 'observe attach');
  const entryId = requireFlag(argv, '--entry', 'observe attach');
  const apiSystems = csv(argv, '--api-systems');
  const decidedBy = requireDecidedBy(argv);
  const scope = resolveScope(argv);
  const rootDir = options.rootDir;

  const summary = loadObservationSummary(memberId, summaryId, { rootDir });
  if (!summary) throw new Error(`observation summary not found: ${summaryId}`);
  const entry = loadWorkInventoryEntry(scope, entryId, { rootDir });
  if (!entry) throw new Error(`work inventory entry not found: ${entryId}`);

  const attached = attachObservationToEntry(entry, summary, {
    by: { kind: 'human', id: bareMemberId(decidedBy) },
    now: options.now,
    rootDir,
    ...(apiSystems.length > 0 ? { apiSystems } : {}),
  });
  return saveWorkInventoryEntry(attached, { rootDir });
}

export function formatObservationSummary(summary: WorkInventoryObservationSummary): string {
  return [
    `${summary.summary_id}  [${summary.status}]`,
    observationDigestLine(summary),
    `consent: ${summary.consent_id}`,
  ].join('\n');
}

export function formatObservationSummaryList(
  summaries: readonly WorkInventoryObservationSummary[]
): string {
  return formatTable(
    ['summary_id', 'status', 'digest', 'consent_id'],
    summaries.map((summary) => [
      summary.summary_id,
      summary.status,
      observationDigestLine(summary),
      summary.consent_id,
    ])
  );
}
