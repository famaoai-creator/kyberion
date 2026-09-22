/**
 * WI-07: `pnpm inventory consent ...` and `pnpm inventory observe ...`
 * command handlers.
 *
 * Who acts: the terminal CLI runs on this machine as its local owner — the
 * same trust a presence-studio loopback viewer gets
 * (`resolveMemberByPrincipal({ source: 'loopback' })`). Consent and
 * observation records therefore always belong to the owner member: `--member`
 * and `--decided-by`, when given, must name the owner, so nobody can act as
 * another member by passing two matching flags. Other members consent through
 * their own authenticated surface (not this CLI).
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveMemberByPrincipal } from '@agent/core/member-registry';
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
import { resolveDecidedByFromArgv } from './decided-by-args.js';
import {
  csv,
  formatTable,
  getFlag,
  requireFlag,
  resolveScope,
  WorkInventoryCliUsageError,
} from './work-inventory-cli-shared.js';
import type { WorkInventoryCliOptions } from './work-inventory-cli-entries.js';

// ---------------------------------------------------------------------------
// Local owner (the only member this terminal CLI may act as)
// ---------------------------------------------------------------------------

export interface LocalOwnerActor {
  /** Bare member id consent/observation records are keyed by. */
  member_id: string;
  by: { kind: 'human'; id: string };
}

/**
 * Resolves the member this CLI acts as: the local owner. `--member`, if
 * given, must equal the owner id and `--decided-by`, if given, must be
 * `user:<owner>`. Fails when no owner member is provisioned yet.
 */
export function resolveLocalOwnerActor(
  argv: string[],
  subcommand: string,
  options: WorkInventoryCliOptions = {}
): LocalOwnerActor {
  const owner = resolveMemberByPrincipal(
    { source: 'loopback' },
    options.rootDir ? { rootDir: options.rootDir } : {}
  );
  if (!owner) {
    throw new WorkInventoryCliUsageError(
      `${subcommand}: no active owner member is provisioned on this machine — complete onboarding (pnpm onboard, which provisions it via ensureOwnerMember) first`
    );
  }
  const ownerId = owner.member_id;
  const member = getFlag(argv, '--member');
  if (member !== undefined && member !== ownerId) {
    throw new WorkInventoryCliUsageError(
      `${subcommand}: this CLI acts as the local owner (${ownerId}); --member ${member} is not allowed — other members consent through their own authenticated surface`
    );
  }
  let decidedBy: ReturnType<typeof resolveDecidedByFromArgv>;
  try {
    decidedBy = resolveDecidedByFromArgv(argv);
  } catch (error) {
    throw new WorkInventoryCliUsageError(error instanceof Error ? error.message : String(error));
  }
  if (decidedBy && decidedBy.id !== `user:${ownerId}`) {
    throw new WorkInventoryCliUsageError(
      `${subcommand}: this CLI acts as the local owner; --decided-by must be user:${ownerId}, got ${decidedBy.id}`
    );
  }
  return { member_id: ownerId, by: { kind: 'human', id: ownerId } };
}

// ---------------------------------------------------------------------------
// consent
// ---------------------------------------------------------------------------

export function runConsentGrant(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryConsent {
  const actor = resolveLocalOwnerActor(argv, 'consent grant', options);
  const sources = csv(argv, '--sources') as WorkInventoryConsentSource[];
  const kinds = csv(argv, '--kinds') as WorkInventoryObservationKind[];
  const purpose = requireFlag(argv, '--purpose', 'consent grant');
  const daysRaw = requireFlag(argv, '--days', 'consent grant');
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days must be a positive number, got "${daysRaw}"`);
  }
  const scope = resolveScope(argv);
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  return grantWorkInventoryConsent(
    {
      member_id: actor.member_id,
      ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
      sources,
      observation_kinds: kinds,
      purpose,
      expires_at: expiresAt,
      granted_by: actor.by,
    },
    { rootDir: options.rootDir, now }
  );
}

export function runConsentRevoke(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryConsent {
  const actor = resolveLocalOwnerActor(argv, 'consent revoke', options);
  const consentId = requireFlag(argv, '--consent', 'consent revoke');
  return revokeWorkInventoryConsent(actor.member_id, consentId, {
    rootDir: options.rootDir,
    now: options.now,
    by: actor.by,
  });
}

export function runConsentList(
  argv: string[],
  options: WorkInventoryCliOptions
): WorkInventoryConsent[] {
  const actor = resolveLocalOwnerActor(argv, 'consent list', options);
  return listWorkInventoryConsents(actor.member_id, { rootDir: options.rootDir });
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

/**
 * Recordings under `active/shared/runtime/recordings/` are captured on this
 * machine by its owner (`pnpm kyberion record` / the browser extension bridge),
 * which is why summarizing them is attributed to the local owner member.
 */
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
  const actor = resolveLocalOwnerActor(argv, 'observe summarize', options);
  const recordingArg = requireFlag(argv, '--recording', 'observe summarize');
  const scope = resolveScope(argv);
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const safePath = resolveRecordingPath(recordingArg, rootDir);
  const recording = loadInventoryRecording(safePath);
  return summarizeRecordingForInventory(recording, {
    member_id: actor.member_id,
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    now: options.now,
    rootDir,
  });
}

export function runObserveConfirm(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryObservationSummary {
  const actor = resolveLocalOwnerActor(argv, 'observe confirm', options);
  const summaryId = requireFlag(argv, '--summary', 'observe confirm');
  return confirmObservationSummary(actor.member_id, summaryId, {
    rootDir: options.rootDir,
    now: options.now,
    by: actor.by,
  });
}

export function runObserveDiscard(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryObservationSummary {
  const actor = resolveLocalOwnerActor(argv, 'observe discard', options);
  const summaryId = requireFlag(argv, '--summary', 'observe discard');
  return discardObservationSummary(actor.member_id, summaryId, {
    rootDir: options.rootDir,
    now: options.now,
    by: actor.by,
  });
}

export function runObserveList(
  argv: string[],
  options: WorkInventoryCliOptions
): WorkInventoryObservationSummary[] {
  const actor = resolveLocalOwnerActor(argv, 'observe list', options);
  return listObservationSummaries(actor.member_id, { rootDir: options.rootDir });
}

export function runObserveAttach(
  argv: string[],
  options: WorkInventoryCliOptions & { now?: Date }
): WorkInventoryEntry {
  const actor = resolveLocalOwnerActor(argv, 'observe attach', options);
  const summaryId = requireFlag(argv, '--summary', 'observe attach');
  const entryId = requireFlag(argv, '--entry', 'observe attach');
  const apiSystems = csv(argv, '--api-systems');
  const scope = resolveScope(argv);
  const rootDir = options.rootDir;

  const summary = loadObservationSummary(actor.member_id, summaryId, { rootDir });
  if (!summary) throw new Error(`observation summary not found: ${summaryId}`);
  const entry = loadWorkInventoryEntry(scope, entryId, { rootDir });
  if (!entry) throw new Error(`work inventory entry not found: ${entryId}`);

  const attached = attachObservationToEntry(entry, summary, {
    by: actor.by,
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
