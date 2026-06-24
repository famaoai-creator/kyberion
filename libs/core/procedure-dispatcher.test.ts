import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bridge from './browser-extension-bridge.js';
import * as approvalGate from './approval-gate.js';
import { type ProcedureEntry } from './procedure-types.js';
import {
  dispatchProcedure,
  extendLeaseForMfa,
  type DispatchInput,
} from './procedure-dispatcher.js';
import type { BrowserExtensionRecording, BrowserExtensionSessionRequest } from './browser-extension-bridge.js';
import type { ServiceRecording } from './service-recording.js';

const SERVICE_PROCEDURE: ProcedureEntry = {
  procedure_id: 'deal.intake.jira-slack',
  substrate: 'service',
  adapter: { recorder: 'service-capture', executor: 'service:preset' },
  target: { name: 'Deal Intake', services: ['jira', 'slack'] },
  intent_phrases: ['起票して通知'],
  pipeline_ref: 'pipelines/service/deal-intake.json',
  risk_class: 'high', version: '1.0.0', status: 'active',
};

function serviceRecording(overrides: Partial<ServiceRecording> = {}): ServiceRecording {
  return {
    schema_version: 'service-recording.v1',
    recording_id: 'svc-1', source: 'service-capture', created_at: '2026-06-24T00:00:00.000Z',
    target: { name: 'Deal Intake', services: ['jira', 'slack'] },
    steps: [
      { step_id: 's1', service_id: 'jira', action: 'create_issue', summary: '起票', risk_class: 'high', produces: 'issue_key' },
    ],
    risk_summary: { requires_manual_review: true, approval_required_count: 1 },
    review: { status: 'approved', decisions: [{ step_id: 's1', status: 'approved' }] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROCEDURE: ProcedureEntry = {
  procedure_id: 'attendance.approve.kingoftime',
  substrate: 'browser',
  adapter: { recorder: 'chrome-extension', executor: 'extension_session' },
  target: { name: 'King of Time', origins: ['https://s2.kingtime.jp'] },
  intent_phrases: ['勤怠の承認'],
  execution_substrate: 'extension',
  pipeline_ref: 'pipelines/browser/attendance.approve.json',
  risk_class: 'high',
  version: '1.0.0',
  status: 'active',
};

const RECORDING: BrowserExtensionRecording = {
  schema_version: 'browser-recording.v1',
  recording_id: 'rec-001',
  source: 'chrome-extension',
  created_at: '2026-06-24T00:00:00Z',
  tab: { origin: 'https://s2.kingtime.jp', origin_hash: 'h1', title: 'King of Time' },
  extension: { version: '1.0.0' },
  actions: [],
  risk_summary: { requires_manual_review: true, sensitive_input_omitted: 0, approval_required_count: 0 },
  review: {
    status: 'approved',
    reviewed_at: '2026-06-24T00:00:00Z',
    decisions: [{ action_id: 'placeholder', status: 'approved' }],
  },
};

const SESSION: BrowserExtensionSessionRequest = {
  kind: 'browser-extension-session.v1',
  mission_id: 'msn-001',
  pipeline_id: 'pipe-001',
  tab_id: 'tab-1',
  origin: 'https://s2.kingtime.jp',
  mode: 'record',
  recording_id: 'rec-001',
  requested_operations: ['snapshot'],
};

const BASE_INPUT: DispatchInput = {
  procedure: PROCEDURE,
  agentId: 'test-agent',
  missionId: 'msn-001',
  recording: RECORDING,
  session: SESSION,
};

// ---------------------------------------------------------------------------
// dispatchProcedure — routing
// ---------------------------------------------------------------------------

describe('dispatchProcedure', () => {
  afterEach(() => vi.restoreAllMocks());

  it('blocks a service:preset dispatch with no serviceRecording', async () => {
    const input: DispatchInput = {
      ...BASE_INPUT,
      procedure: { ...PROCEDURE, adapter: { ...PROCEDURE.adapter, executor: 'service:preset' } },
    };
    const result = await dispatchProcedure(input);
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('serviceRecording');
  });

  it('returns not_implemented for system (desktop) executor', async () => {
    const input: DispatchInput = {
      ...BASE_INPUT,
      procedure: { ...PROCEDURE, adapter: { ...PROCEDURE.adapter, executor: 'system' } },
    };
    const result = await dispatchProcedure(input);
    expect(result.status).toBe('not_implemented');
  });

  it('returns blocked for unknown executor', async () => {
    const input: DispatchInput = {
      ...BASE_INPUT,
      procedure: { ...PROCEDURE, adapter: { ...PROCEDURE.adapter, executor: 'quantum' as any } },
    };
    const result = await dispatchProcedure(input);
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('quantum');
  });

  // -------------------------------------------------------------------------
  // extension_session substrate
  // -------------------------------------------------------------------------

  it('returns blocked when recording is missing', async () => {
    const result = await dispatchProcedure({ ...BASE_INPUT, recording: undefined });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('recording');
  });

  it('returns blocked when session is missing', async () => {
    const result = await dispatchProcedure({ ...BASE_INPUT, session: undefined });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('session');
  });

  it('returns blocked when recording origin is not in procedure allowed origins', async () => {
    const wrongOriginRecording: BrowserExtensionRecording = {
      ...RECORDING,
      tab: { ...RECORDING.tab, origin: 'https://evil.example.com' },
    };
    const result = await dispatchProcedure({ ...BASE_INPUT, recording: wrongOriginRecording });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('evil.example.com');
    expect(result.errors[0]).toContain('not in allowed origins');
  });

  it('issues one origin-bound lease per segment for a multi-origin recording', async () => {
    // preflight internals are covered by their own suite; mock to ready so this
    // test focuses on the dispatcher's segmentation + per-segment lease wiring.
    vi.spyOn(bridge, 'preflightBrowserExtensionSession').mockReturnValue({
      status: 'ready_for_review', errors: [], approvalRequired: false, approvedStepHashes: [],
    });
    const multiOrigin: ProcedureEntry = {
      ...PROCEDURE,
      target: { ...PROCEDURE.target, origins: ['https://s2.kingtime.jp', 'https://news.yahoo.co.jp'] },
    };
    const segmentedRecording: BrowserExtensionRecording = {
      ...RECORDING,
      actions: [
        {
          action_id: 'nav-1', op: 'navigate', summary: 'handoff', risk: 'observe',
          captured_at: '2026-06-24T00:00:01Z',
          navigation: { from_origin: 'https://s2.kingtime.jp', to_origin: 'https://news.yahoo.co.jp' },
        },
      ],
    };
    const result = await dispatchProcedure({ ...BASE_INPUT, procedure: multiOrigin, recording: segmentedRecording });
    expect(result.status).toBe('lease_issued');
    expect(result.segments).toHaveLength(2);
    expect(result.segments?.map((s) => s.origin)).toEqual(['https://s2.kingtime.jp', 'https://news.yahoo.co.jp']);
    expect(result.segments?.[0].lease.origin).toBe('https://s2.kingtime.jp');
    expect(result.segments?.[1].lease.segment_index).toBe(1);
    expect(result.lease).toBeUndefined();
  });

  it('blocks a multi-origin recording whose segment origin is not in the procedure allowlist', async () => {
    const segmentedRecording: BrowserExtensionRecording = {
      ...RECORDING,
      actions: [
        {
          action_id: 'nav-1', op: 'navigate', summary: 'handoff', risk: 'observe',
          captured_at: '2026-06-24T00:00:01Z',
          navigation: { from_origin: 'https://s2.kingtime.jp', to_origin: 'https://evil.example.com' },
        },
      ],
    };
    // PROCEDURE only allows kingtime; the news/evil segment origin is not allowed.
    const result = await dispatchProcedure({ ...BASE_INPUT, recording: segmentedRecording });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('evil.example.com');
  });

  it('returns approval_required when approval gate blocks', async () => {
    vi.spyOn(bridge, 'enforceBrowserExtensionApproval').mockReturnValue({
      allowed: false,
      status: 'pending',
      requestId: 'REQ-42',
      message: 'Pending approval',
    });
    const result = await dispatchProcedure(BASE_INPUT);
    expect(result.status).toBe('approval_required');
    expect(result.approvalRequestId).toBe('REQ-42');
    expect(result.errors).toHaveLength(0);
  });

  it('returns lease_issued when approval is granted', async () => {
    const mockLease: bridge.BrowserExtensionLease = {
      lease_id: 'LEASE-123',
      issued_at: '2026-06-24T00:00:00Z',
      expires_at: '2026-06-24T00:05:00Z',
      approved_step_hashes: [],
    };
    vi.spyOn(bridge, 'enforceBrowserExtensionApproval').mockReturnValue({
      allowed: true,
      status: 'not_required',
    });
    vi.spyOn(bridge, 'issueBrowserExtensionLease').mockReturnValue({
      errors: [],
      lease: mockLease,
    });
    const result = await dispatchProcedure(BASE_INPUT);
    expect(result.status).toBe('lease_issued');
    expect(result.lease?.lease_id).toBe('LEASE-123');
    expect(result.errors).toHaveLength(0);
  });

  it('returns blocked when lease issuance fails', async () => {
    vi.spyOn(bridge, 'enforceBrowserExtensionApproval').mockReturnValue({
      allowed: true,
      status: 'not_required',
    });
    vi.spyOn(bridge, 'issueBrowserExtensionLease').mockReturnValue({
      errors: ['recording review not approved'],
    });
    const result = await dispatchProcedure(BASE_INPUT);
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('recording review not approved');
  });

  it('passes channel and correlationId to approval gate', async () => {
    const spy = vi.spyOn(bridge, 'enforceBrowserExtensionApproval').mockReturnValue({
      allowed: false,
      status: 'pending',
    });
    await dispatchProcedure({
      ...BASE_INPUT,
      channel: 'sidepanel',
      correlationId: 'corr-xyz',
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'sidepanel',
        correlationId: 'corr-xyz',
      }),
    );
  });

  it('allows recording from sub-path of allowed origin', async () => {
    const subPathRecording: BrowserExtensionRecording = {
      ...RECORDING,
      tab: { ...RECORDING.tab, origin: 'https://s2.kingtime.jp' },
    };
    vi.spyOn(bridge, 'enforceBrowserExtensionApproval').mockReturnValue({
      allowed: true,
      status: 'not_required',
    });
    vi.spyOn(bridge, 'issueBrowserExtensionLease').mockReturnValue({
      errors: [],
      lease: {
        lease_id: 'L1',
        issued_at: '2026-06-24T00:00:00Z',
        expires_at: '2026-06-24T00:05:00Z',
        approved_step_hashes: [],
      },
    });
    const result = await dispatchProcedure({ ...BASE_INPUT, recording: subPathRecording });
    expect(result.status).toBe('lease_issued');
  });
});

// ---------------------------------------------------------------------------
// extendLeaseForMfa
// ---------------------------------------------------------------------------

describe('extendLeaseForMfa', () => {
  const now = new Date('2026-06-24T10:00:00Z');

  const existingLease: bridge.BrowserExtensionLease = {
    lease_id: 'LEASE-original',
    issued_at: '2026-06-24T09:55:00Z',
    expires_at: '2026-06-24T10:00:00Z',  // expires exactly at `now`
    approved_step_hashes: ['hash1', 'hash2'],
  };

  it('issues a new lease carrying over approved_step_hashes', () => {
    const result = extendLeaseForMfa({
      existingLease,
      recording: RECORDING,
      session: SESSION,
      now,
    });
    expect(result.errors).toHaveLength(0);
    expect(result.lease).toBeDefined();
    expect(result.lease?.approved_step_hashes).toEqual(['hash1', 'hash2']);
    expect(result.lease?.lease_id).not.toBe('LEASE-original');
    expect(result.lease?.lease_id).toMatch(/^LEASE-MFA-/);
  });

  it('new lease expires approximately 10 minutes after now', () => {
    const result = extendLeaseForMfa({ existingLease, recording: RECORDING, session: SESSION, now });
    const expiresAt = Date.parse(result.lease!.expires_at);
    const diff = expiresAt - now.getTime();
    expect(diff).toBeCloseTo(10 * 60_000, -3);  // within ~1s tolerance
  });

  it('refuses extension when the lease is already expired (no past-expiry grace)', () => {
    const staleExpiry = new Date(now.getTime() - 1 * 60_000).toISOString(); // 1 min ago
    const staleLease = { ...existingLease, expires_at: staleExpiry };
    const result = extendLeaseForMfa({
      existingLease: staleLease,
      recording: RECORDING,
      session: SESSION,
      now,
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('expired');
    expect(result.lease).toBeUndefined();
  });

  it('allows extension while the lease is still valid', () => {
    const futureExpiry = new Date(now.getTime() + 1 * 60_000).toISOString(); // 1 min from now
    const validLease = { ...existingLease, expires_at: futureExpiry };
    const result = extendLeaseForMfa({
      existingLease: validLease,
      recording: RECORDING,
      session: SESSION,
      now,
    });
    expect(result.errors).toHaveLength(0);
    expect(result.lease).toBeDefined();
  });

  it('refuses to chain a second MFA extension (single-extension cap)', () => {
    const alreadyExtended = { ...existingLease, lease_id: 'LEASE-MFA-abc' };
    const result = extendLeaseForMfa({
      existingLease: alreadyExtended,
      recording: RECORDING,
      session: SESSION,
      now,
    });
    expect(result.errors.some((e) => e.includes('already been MFA-extended'))).toBe(true);
    expect(result.lease).toBeUndefined();
  });

  it('refuses extension when recording is not approved', () => {
    const unapprovedRecording: BrowserExtensionRecording = {
      ...RECORDING,
      review: { status: 'pending', decisions: [] },
    };
    const result = extendLeaseForMfa({
      existingLease,
      recording: unapprovedRecording,
      session: SESSION,
      now,
    });
    expect(result.errors.some((e) => e.includes('approved recording'))).toBe(true);
    expect(result.lease).toBeUndefined();
  });

  it('refuses extension when session recording_id does not match', () => {
    const mismatchSession = { ...SESSION, recording_id: 'rec-999' };
    const result = extendLeaseForMfa({
      existingLease,
      recording: RECORDING,
      session: mismatchSession,
      now,
    });
    expect(result.errors.some((e) => e.includes('recording_id'))).toBe(true);
    expect(result.lease).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dispatchProcedure — service substrate (E2E)
// ---------------------------------------------------------------------------

describe('dispatchProcedure — service:preset', () => {
  afterEach(() => vi.restoreAllMocks());

  const baseInput = (): DispatchInput => ({
    procedure: SERVICE_PROCEDURE,
    agentId: 'test-agent',
    missionId: 'msn-1',
    serviceRecording: serviceRecording(),
    executePreset: async () => ({ issue_key: 'JIRA-1' }),
  });

  it('executes after approval and returns service results', async () => {
    vi.spyOn(approvalGate, 'enforceApprovalGate').mockReturnValue({ allowed: true, status: 'approved' });
    const result = await dispatchProcedure(baseInput());
    expect(result.status).toBe('executed');
    expect(result.serviceResults?.[0]).toMatchObject({ step_id: 's1', status: 'done' });
  });

  it('returns approval_required when the external-effect gate blocks', async () => {
    vi.spyOn(approvalGate, 'enforceApprovalGate').mockReturnValue({ allowed: false, status: 'pending', requestId: 'REQ-9' });
    const result = await dispatchProcedure(baseInput());
    expect(result.status).toBe('approval_required');
    expect(result.approvalRequestId).toBe('REQ-9');
  });

  it('runs read-only recordings without invoking the approval gate', async () => {
    const spy = vi.spyOn(approvalGate, 'enforceApprovalGate');
    const readOnly = serviceRecording({
      steps: [{ step_id: 'r1', service_id: 'jira', action: 'search', summary: '検索', risk_class: 'read' }],
      risk_summary: { requires_manual_review: true, approval_required_count: 0 },
      review: { status: 'approved', decisions: [{ step_id: 'r1', status: 'approved' }] },
    });
    const result = await dispatchProcedure({ ...baseInput(), serviceRecording: readOnly });
    expect(result.status).toBe('executed');
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks a step whose service is not in the procedure allowlist', async () => {
    const offlist = serviceRecording({
      steps: [{ step_id: 's1', service_id: 'box', action: 'upload', summary: 'x', risk_class: 'high' }],
      review: { status: 'approved', decisions: [{ step_id: 's1', status: 'approved' }] },
    });
    const result = await dispatchProcedure({ ...baseInput(), serviceRecording: offlist });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('not in allowed services');
  });

  it('blocks when the recording review is not approved', async () => {
    const pending = serviceRecording({ review: { status: 'pending', decisions: [] } });
    const result = await dispatchProcedure({ ...baseInput(), serviceRecording: pending });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('approved recording review');
  });
});
