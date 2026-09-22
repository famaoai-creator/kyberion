import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: recordMock } }));

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from './secure-io.js';
import {
  buildDesktopRecording,
  type DesktopObservationSnapshot,
  type DesktopRecording,
} from './desktop-recording.js';
import type { BrowserExtensionRecording } from './browser-extension-bridge.js';
import { createWorkInventoryEntry, validateWorkInventoryEntry } from './work-inventory.js';
import {
  grantWorkInventoryConsent,
  revokeWorkInventoryConsent,
  WorkInventoryConsentError,
  type GrantWorkInventoryConsentInput,
} from './work-inventory-consent.js';
import {
  attachObservationToEntry,
  confirmObservationSummary,
  deriveObservationDigest,
  discardObservationSummary,
  hostnameOnly,
  listObservationSummaries,
  observationSummaryPath,
  opKindFor,
  summarizeRecordingForInventory,
  validateObservationSummary,
} from './work-inventory-observation.js';

const SENTINEL = 'qqsentinelqq';
const T0 = Date.parse('2026-09-22T08:00:00.000Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const at = (ms: number) => new Date(T0 + ms);
const ALICE = { kind: 'human' as const, id: 'alice' };
const BOB = { kind: 'human' as const, id: 'bob' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function focused(description: string) {
  return {
    application: 'Excel',
    windowTitle: `Budget ${SENTINEL} window`,
    role: 'AXTextField',
    description,
    editable: true,
  };
}

/** A valid, approved desktop recording whose free-text fields all carry the sentinel. */
function desktopRecording(
  options: { createdAt?: Date; review?: DesktopRecording['review'] } = {}
): DesktopRecording {
  const snapshots: DesktopObservationSnapshot[] = [
    {
      application: 'Excel',
      window_title: `Budget ${SENTINEL}`,
      event: { op: 'activate_application' },
    },
    {
      application: 'Excel',
      window_title: `Budget ${SENTINEL}`,
      focused_input: focused(`Amount ${SENTINEL} field`),
      event: { op: 'click_at', x: 10, y: 20 },
    },
    {
      application: 'Excel',
      window_title: `Budget ${SENTINEL}`,
      focused_input: focused(`Amount ${SENTINEL} field`),
      event: { op: 'keystroke_text' },
    },
    {
      application: 'Excel',
      window_title: `Budget ${SENTINEL}`,
      event: { op: 'press_key', params: { key_code: 36 } },
    },
    {
      application: 'Google Chrome',
      window_title: `Inbox ${SENTINEL}`,
      browser_host: 'mail.example.com',
      event: { op: 'paste_text' },
    },
  ];
  const recording = buildDesktopRecording(snapshots, {
    recordingId: 'DR-test-1',
    platform: 'darwin',
    targetName: `target ${SENTINEL}`,
    review: options.review ?? {
      status: 'approved',
      reviewed_at: at(0).toISOString(),
      reviewer: 'alice',
    },
  });
  return { ...recording, created_at: (options.createdAt ?? at(60 * MIN)).toISOString() };
}

function browserRecording(
  options: { start?: number; review?: BrowserExtensionRecording['review'] | null } = {}
): BrowserExtensionRecording {
  const start = options.start ?? 60 * MIN;
  const snapshotHash = sha256('snapshot');
  const iso = (offset: number) => at(start + offset).toISOString();
  const recording: BrowserExtensionRecording = {
    schema_version: 'browser-recording.v1',
    recording_id: 'REC-test-1',
    source: 'chrome-extension',
    created_at: iso(0),
    tab: {
      origin: `https://crm.example.com/customers/${SENTINEL}?q=${SENTINEL}`,
      origin_hash: sha256('https://crm.example.com'),
      title: `Customer ${SENTINEL}`,
    },
    extension: { version: '0.1.0' },
    actions: [
      {
        action_id: 'a1',
        op: 'click_ref',
        summary: `Open ${SENTINEL}`,
        risk: 'low',
        captured_at: iso(1000),
        target: {
          ref: '@e1',
          role: 'button',
          name: `Open ${SENTINEL}`,
          snapshot_hash: snapshotHash,
        },
      },
      {
        action_id: 'a2',
        op: 'fill_ref',
        summary: `Type ${SENTINEL}`,
        risk: 'low',
        captured_at: iso(2000),
        target: {
          ref: '@e2',
          role: 'textbox',
          name: `Name ${SENTINEL}`,
          snapshot_hash: snapshotHash,
        },
        variable: { name: SENTINEL, classification: 'user_input' },
      },
      {
        action_id: 'a3',
        op: 'submit_form',
        summary: `Send ${SENTINEL}`,
        risk: 'high',
        captured_at: iso(12 * MIN),
        target: {
          ref: '@e3',
          role: 'button',
          name: `Send ${SENTINEL}`,
          snapshot_hash: snapshotHash,
        },
      },
    ],
    risk_summary: {
      requires_manual_review: true,
      sensitive_input_omitted: 0,
      approval_required_count: 1,
    },
  };
  if (options.review === null) return recording;
  return {
    ...recording,
    review: options.review ?? {
      status: 'approved',
      reviewed_at: iso(13 * MIN),
      decisions: [
        { action_id: 'a1', status: 'approved' },
        { action_id: 'a2', status: 'approved' },
        { action_id: 'a3', status: 'approved' },
      ],
    },
  };
}

function consentInput(
  overrides: Partial<GrantWorkInventoryConsentInput> = {}
): GrantWorkInventoryConsentInput {
  return {
    member_id: 'alice',
    sources: ['desktop_recording', 'browser_recording'],
    observation_kinds: ['active_window', 'browser_tabs'],
    purpose: 'Work inventory',
    expires_at: at(30 * DAY).toISOString(),
    granted_by: ALICE,
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkInventoryConsentError);
  expect((caught as WorkInventoryConsentError).code).toBe(code);
}

describe('work inventory observation', () => {
  let rootDir = '';
  const NOW = at(2 * 60 * MIN);

  beforeEach(() => {
    recordMock.mockReset();
    rootDir = path.join(
      pathResolver.rootDir(),
      'active/shared/tmp',
      `wi-observation-${randomUUID()}`
    );
    safeMkdir(rootDir, { recursive: true });
  });

  afterEach(() => {
    if (rootDir && safeExistsSync(rootDir)) safeRmSync(rootDir, { recursive: true, force: true });
  });

  function grant(overrides: Partial<GrantWorkInventoryConsentInput> = {}) {
    return grantWorkInventoryConsent(consentInput(overrides), { now: at(0), rootDir });
  }

  describe('summarizeRecordingForInventory gates', () => {
    it('no_consent when the member has none', () => {
      expectCode(
        () =>
          summarizeRecordingForInventory(desktopRecording(), {
            member_id: 'alice',
            now: NOW,
            rootDir,
          }),
        'no_consent'
      );
      expect(listObservationSummaries('alice', { rootDir })).toEqual([]);
    });

    it('no_consent when the recording was made before the consent', () => {
      grant();
      expectCode(
        () =>
          summarizeRecordingForInventory(desktopRecording({ createdAt: at(-MIN) }), {
            member_id: 'alice',
            now: NOW,
            rootDir,
          }),
        'no_consent'
      );
    });

    it('consent_expired when the consent lapsed before summarizing', () => {
      grant({ expires_at: at(90 * MIN).toISOString() });
      expectCode(
        () =>
          summarizeRecordingForInventory(desktopRecording(), {
            member_id: 'alice',
            now: NOW,
            rootDir,
          }),
        'consent_expired'
      );
    });

    it('consent_revoked when revoked between recording and summarize', () => {
      const consent = grant();
      revokeWorkInventoryConsent('alice', consent.consent_id, {
        by: ALICE,
        now: at(90 * MIN),
        rootDir,
      });
      expectCode(
        () =>
          summarizeRecordingForInventory(desktopRecording(), {
            member_id: 'alice',
            now: NOW,
            rootDir,
          }),
        'consent_revoked'
      );
      // A fresh re-grant does not retroactively bless the earlier recording.
      grantWorkInventoryConsent(consentInput(), { now: at(100 * MIN), rootDir });
      expectCode(
        () =>
          summarizeRecordingForInventory(desktopRecording(), {
            member_id: 'alice',
            now: NOW,
            rootDir,
          }),
        'consent_revoked'
      );
    });

    it('source_not_covered when the consent excludes the source', () => {
      grant({ sources: ['desktop_recording'] });
      expectCode(
        () =>
          summarizeRecordingForInventory(browserRecording(), {
            member_id: 'alice',
            now: NOW,
            rootDir,
          }),
        'source_not_covered'
      );
    });

    it('tenant_mismatch when the consent is bound to another tenant', () => {
      grant({ tenant_slug: 'acme-corp' });
      expectCode(
        () =>
          summarizeRecordingForInventory(desktopRecording(), {
            member_id: 'alice',
            tenant_slug: 'other-co',
            now: NOW,
            rootDir,
          }),
        'tenant_mismatch'
      );
    });

    it('recording_not_reviewed for pending desktop and unreviewed browser recordings', () => {
      grant();
      expectCode(
        () =>
          summarizeRecordingForInventory(desktopRecording({ review: { status: 'pending' } }), {
            member_id: 'alice',
            now: NOW,
            rootDir,
          }),
        'recording_not_reviewed'
      );
      expectCode(
        () =>
          summarizeRecordingForInventory(browserRecording({ review: null }), {
            member_id: 'alice',
            now: NOW,
            rootDir,
          }),
        'recording_not_reviewed'
      );
    });

    it('invalid_recording when the recording body was tampered after review', () => {
      grant();
      const tampered = desktopRecording();
      tampered.steps = tampered.steps.slice(1);
      expectCode(
        () => summarizeRecordingForInventory(tampered, { member_id: 'alice', now: NOW, rootDir }),
        'invalid_recording'
      );
    });

    it('another member cannot summarize under alice consent', () => {
      grant();
      expectCode(
        () =>
          summarizeRecordingForInventory(desktopRecording(), {
            member_id: 'bob',
            now: NOW,
            rootDir,
          }),
        'no_consent'
      );
    });
  });

  describe('summaries', () => {
    it('summarizes a desktop recording without any sentinel content', () => {
      grant();
      const recording = desktopRecording();
      const summary = summarizeRecordingForInventory(recording, {
        member_id: 'alice',
        now: NOW,
        rootDir,
      });
      expect(summary.status).toBe('pending_review');
      expect(summary.recording_hash).toBe(recording.recording_hash);
      expect(summary.apps).toEqual(['Excel', 'Google Chrome']);
      expect(summary.hosts).toEqual(['mail.example.com']);
      expect(summary.op_counts).toEqual({ open: 1, click: 1, input: 2, paste: 1 });
      expect(summary.step_count).toBe(5);
      expect(summary.proposed_steps.map((step) => step.description)).toEqual([
        'operate in Excel',
        'enter data in Excel',
        'copy and paste data in Google Chrome',
      ]);
      expect(validateObservationSummary(summary)).toEqual({ valid: true, errors: [] });

      const file = observationSummaryPath('alice', summary.summary_id, rootDir);
      expect(path.relative(rootDir, file)).toBe(
        path.join(
          'knowledge/personal/members/alice/work-inventory/observations',
          `${summary.summary_id}.json`
        )
      );
      const stored = String(safeReadFile(file, { encoding: 'utf8' }));
      expect(stored).not.toContain(SENTINEL);
      expect(JSON.stringify(summary)).not.toContain(SENTINEL);
      expect(stored).not.toContain('DR-test-1');
      expect(recordMock.mock.calls.map((call) => call[0].action)).toContain(
        'work_inventory.observation_summarized'
      );
    });

    it('re-summarizing the same recording on a later day returns the same summary', () => {
      grant();
      const recording = desktopRecording();
      const first = summarizeRecordingForInventory(recording, {
        member_id: 'alice',
        now: NOW,
        rootDir,
      });
      const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
      const second = summarizeRecordingForInventory(recording, {
        member_id: 'alice',
        now: nextDay,
        rootDir,
      });
      expect(second.summary_id).toBe(first.summary_id);
      expect(listObservationSummaries('alice', { rootDir })).toHaveLength(1);
    });

    it('omits app names and hosts the consent does not cover', () => {
      grant({ observation_kinds: ['focused_input'] });
      const summary = summarizeRecordingForInventory(desktopRecording(), {
        member_id: 'alice',
        now: NOW,
        rootDir,
      });
      expect(summary.apps).toEqual([]);
      expect(summary.hosts).toEqual([]);
      expect(summary.proposed_steps[0].description).toBe('operate in a desktop application');
      expect(summary.proposed_steps.every((step) => step.system === undefined)).toBe(true);
    });

    it('summarizes a browser recording with hostname only and flags send for attention', () => {
      grant();
      const summary = summarizeRecordingForInventory(browserRecording(), {
        member_id: 'alice',
        now: NOW,
        rootDir,
      });
      expect(summary.hosts).toEqual(['crm.example.com']);
      expect(summary.apps).toEqual([]);
      expect(summary.duration_ms).toBe(12 * MIN - 1000);
      expect(summary.op_counts).toEqual({ click: 1, input: 1, submit: 1 });
      const send = summary.proposed_steps.find((step) => step.verb === 'communicate');
      expect(send).toMatchObject({ effects: ['external_send'], requires_attention: true });
      expect(JSON.stringify(summary)).not.toContain(SENTINEL);
      expect(validateObservationSummary(summary).valid).toBe(true);
    });

    it('never copies hostile fields even from unvalidated recordings (pure digest)', () => {
      const hostile = {
        ...desktopRecording(),
        target: { name: SENTINEL, platform: 'darwin' as const, app: `Evil ${SENTINEL}/../x` },
        steps: [
          {
            step_id: 's1',
            op: `drop table ${SENTINEL}`,
            summary: SENTINEL,
            risk_class: 'high' as const,
            selector: {
              app: 'Excel',
              window_title: SENTINEL,
              description: SENTINEL,
              role: SENTINEL,
            },
            variable: { name: SENTINEL, classification: 'user_input' as const },
            params: { text: SENTINEL, url: `https://x.example.com/${SENTINEL}` },
            evidence: [
              `browser_tabs:host:x.example.com/${SENTINEL}?q=${SENTINEL}`,
              `clipboard:${SENTINEL}`,
            ],
            frame_ref: `frames/${SENTINEL}.png`,
          },
        ],
      };
      const digest = deriveObservationDigest(hostile, [
        'active_window',
        'browser_tabs',
        'focused_input',
        // even if a forbidden kind slipped through, nothing is read from it
        'clipboard',
        'screen_frame',
      ]);
      expect(JSON.stringify(digest)).not.toContain(SENTINEL);
      expect(digest.op_counts).toEqual({ other: 1 });
      expect(digest.hosts).toEqual(['x.example.com']);
    });

    it('op kind and hostname helpers are allowlist-only', () => {
      expect(opKindFor('mouse_click')).toBe('click');
      expect(opKindFor('fill_ref')).toBe('input');
      expect(opKindFor('download_file')).toBe('download');
      expect(opKindFor('__proto__')).toBe('other');
      expect(opKindFor('constructor')).toBe('other');
      expect(hostnameOnly('https://user:pw@mail.example.com:8443/a/b?c=d#e')).toBe(
        'mail.example.com'
      );
      expect(hostnameOnly('not a host')).toBeUndefined();
    });
  });

  describe('member decisions and attach', () => {
    function summarize() {
      grant({ tenant_slug: 'acme-corp' });
      return summarizeRecordingForInventory(desktopRecording(), {
        member_id: 'alice',
        tenant_slug: 'acme-corp',
        now: NOW,
        rootDir,
      });
    }

    function tenantEntry(tenant = 'acme-corp') {
      return createWorkInventoryEntry(
        {
          title: 'Monthly budget update',
          scope: { tenant_slug: tenant, owner_member_id: 'alice' },
          trigger: { kind: 'schedule', description: 'month end' },
        },
        at(0)
      );
    }

    it('only the member can confirm or discard', () => {
      const summary = summarize();
      expectCode(
        () =>
          confirmObservationSummary('alice', summary.summary_id, { by: BOB, now: NOW, rootDir }),
        'not_subject'
      );
      expectCode(
        () =>
          discardObservationSummary('alice', summary.summary_id, { by: BOB, now: NOW, rootDir }),
        'not_subject'
      );
      const discarded = discardObservationSummary('alice', summary.summary_id, {
        by: ALICE,
        now: NOW,
        rootDir,
      });
      expect(discarded.status).toBe('discarded');
      expectCode(
        () =>
          confirmObservationSummary('alice', summary.summary_id, { by: ALICE, now: NOW, rootDir }),
        'invalid_state'
      );
    });

    it('attach requires a confirmed summary and the member themself', () => {
      const summary = summarize();
      expectCode(
        () => attachObservationToEntry(tenantEntry(), summary, { by: ALICE, now: NOW, rootDir }),
        'invalid_state'
      );
      // Forging the in-memory status does not help: the stored record is authoritative.
      expectCode(
        () =>
          attachObservationToEntry(
            tenantEntry(),
            { ...summary, status: 'confirmed' },
            {
              by: ALICE,
              now: NOW,
              rootDir,
            }
          ),
        'invalid_state'
      );
      const confirmed = confirmObservationSummary('alice', summary.summary_id, {
        by: ALICE,
        now: NOW,
        rootDir,
      });
      expectCode(
        () => attachObservationToEntry(tenantEntry(), confirmed, { by: BOB, now: NOW, rootDir }),
        'not_subject'
      );
    });

    it('attach rejects a tenant mismatch', () => {
      const summary = summarize();
      const confirmed = confirmObservationSummary('alice', summary.summary_id, {
        by: ALICE,
        now: NOW,
        rootDir,
      });
      expectCode(
        () =>
          attachObservationToEntry(tenantEntry('other-co'), confirmed, {
            by: ALICE,
            now: NOW,
            rootDir,
          }),
        'tenant_mismatch'
      );
    });

    it('attaches a confirmed summary: seeds steps, classifies, audits the crossing, no sentinel', () => {
      const summary = summarize();
      const confirmed = confirmObservationSummary('alice', summary.summary_id, {
        by: ALICE,
        now: NOW,
        rootDir,
      });
      expect(validateObservationSummary(confirmed).valid).toBe(true);
      recordMock.mockReset();

      const entry = tenantEntry();
      const next = attachObservationToEntry(entry, confirmed, { by: ALICE, now: NOW, rootDir });
      expect(next.observations).toEqual([
        {
          source: 'desktop_recording',
          ref: `observation:${summary.summary_id}`,
          observed_at: confirmed.window.end,
          digest: '5 ops in Excel, Google Chrome, mail.example.com',
          metrics: { count: 5 },
        },
      ]);
      expect(next.steps.map((step) => [step.verb, step.system, step.method.source])).toEqual([
        ['operate', 'Excel', 'rule'],
        ['input', 'Excel', 'rule'],
        ['transform', 'Google Chrome', 'rule'],
      ]);
      expect(validateWorkInventoryEntry(next)).toEqual({ valid: true, errors: [] });
      expect(JSON.stringify(next)).not.toContain(SENTINEL);

      expect(recordMock).toHaveBeenCalledTimes(1);
      const event = recordMock.mock.calls[0][0];
      expect(event.action).toBe('work_inventory.observation_attached');
      expect(event.tenantSlug).toBe('acme-corp');
      expect(event.metadata).toMatchObject({
        member_id: 'alice',
        summary_id: summary.summary_id,
        entry_id: entry.entry_id,
        tenant_slug: 'acme-corp',
        from_tier: 'personal',
        to_tier: 'confidential',
      });

      // Attaching the same observation twice is refused.
      expectCode(
        () => attachObservationToEntry(next, confirmed, { by: ALICE, now: NOW, rootDir }),
        'invalid_state'
      );
    });

    it('keeps existing steps and writes a duration digest for browser summaries', () => {
      grant();
      const summary = summarizeRecordingForInventory(browserRecording(), {
        member_id: 'alice',
        now: NOW,
        rootDir,
      });
      const confirmed = confirmObservationSummary('alice', summary.summary_id, {
        by: ALICE,
        now: NOW,
        rootDir,
      });
      const entry = createWorkInventoryEntry(
        {
          title: 'CRM follow-up',
          scope: {},
          trigger: { kind: 'event', description: 'lead arrives' },
          steps: [
            {
              step_id: 'S1',
              stage: 'act',
              verb: 'input',
              description: 'enter lead',
              data_sensitivity: 'internal',
              effects: [],
              method: { assigned: 'human', source: 'proposal', rationale: 'guess' },
            },
          ],
        },
        at(0)
      );
      const next = attachObservationToEntry(entry, confirmed, { by: ALICE, now: NOW, rootDir });
      expect(next.steps).toHaveLength(1);
      expect(next.observations?.[0].digest).toBe('3 ops in crm.example.com over 12 min');
      expect(next.observations?.[0].metrics).toEqual({
        count: 3,
        median_duration_ms: 12 * MIN - 1000,
      });
      expect(recordMock.mock.calls.at(-1)?.[0].metadata.to_tier).toBe('personal');
    });
  });
});
