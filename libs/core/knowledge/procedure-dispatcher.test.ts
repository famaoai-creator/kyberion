import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { saveGoldenScenario } from './golden-scenario-verdict.js';
import { resolveKnowledgeVerification } from './knowledge-verification.js';
import * as bridge from '../browser/browser-extension-bridge.js';
import * as approvalGate from '../governance/approval-gate.js';
import * as killSwitch from '../governance/kill-switch.js';
import { type GoldenScenario, type ProcedureEntry } from './procedure-types.js';
import {
  dispatchProcedure,
  extendLeaseForMfa,
  type DispatchInput,
} from './procedure-dispatcher.js';
import type {
  BrowserExtensionRecording,
  BrowserExtensionSessionRequest,
} from '../browser/browser-extension-bridge.js';
import {
  serviceRecordingContentHash,
  type ServiceRecording,
} from '../service/service-recording.js';
import {
  computeDesktopRecordingHash,
  type DesktopRecording,
} from '../virtual/desktop-recording.js';
import {
  intentDraftHash,
  reconstructDesktopIntent,
  reviewDesktopIntent,
  type DesktopIntentDraft,
} from '../virtual/desktop-intent-reconstruction.js';
import type { DesktopPipeline } from '../virtual/desktop-pipeline.js';

const SERVICE_PROCEDURE: ProcedureEntry = {
  procedure_id: 'deal.intake.jira-slack',
  substrate: 'service',
  adapter: { recorder: 'service-capture', executor: 'service:preset' },
  target: { name: 'Deal Intake', services: ['jira', 'slack'] },
  intent_phrases: ['起票して通知'],
  pipeline_ref: 'pipelines/service/deal-intake.json',
  risk_class: 'high',
  version: '1.0.0',
  status: 'active',
};

function serviceRecording(overrides: Partial<ServiceRecording> = {}): ServiceRecording {
  const recording: ServiceRecording = {
    schema_version: 'service-recording.v1',
    recording_id: 'svc-1',
    source: 'service-capture',
    created_at: '2026-06-24T00:00:00.000Z',
    target: { name: 'Deal Intake', services: ['jira', 'slack'] },
    steps: [
      {
        step_id: 's1',
        service_id: 'jira',
        action: 'create_issue',
        summary: '起票',
        risk_class: 'high',
        produces: 'issue_key',
      },
    ],
    risk_summary: { requires_manual_review: true, approval_required_count: 1 },
    review: { status: 'approved', decisions: [{ step_id: 's1', status: 'approved' }] },
    ...overrides,
  };
  if (recording.review?.status === 'approved' && !recording.review.content_hash) {
    recording.review.content_hash = serviceRecordingContentHash(recording);
  }
  return recording;
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
  risk_summary: {
    requires_manual_review: true,
    sensitive_input_omitted: 0,
    approval_required_count: 0,
  },
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

function desktopPipeline(procedure: ProcedureEntry, recording: DesktopRecording): DesktopPipeline {
  return {
    schema_version: 'desktop-pipeline.v1',
    procedure_id: procedure.procedure_id,
    executor: 'system',
    recording_ref: procedure.adapter.recording_ref!,
    recording_hash: recording.recording_hash,
    steps: recording.steps.map((step) => ({
      step_id: step.step_id,
      op: `system:${step.op}`,
      risk_class: step.risk_class,
      ...(step.selector ? { selector: step.selector } : {}),
    })),
  };
}

function approveDesktopIntent(recording: DesktopRecording): DesktopIntentDraft {
  const intent = reviewDesktopIntent(reconstructDesktopIntent(recording), 'approved', 'operator');
  recording.intent_hash = intentDraftHash(intent);
  recording.recording_hash = computeDesktopRecordingHash(recording);
  return intent;
}

// ---------------------------------------------------------------------------
// dispatchProcedure — routing
// ---------------------------------------------------------------------------

describe('dispatchProcedure', () => {
  afterEach(() => vi.restoreAllMocks());

  it('blocks a service:preset dispatch with no serviceRecording', async () => {
    const logSpy = vi.spyOn(killSwitch.killSwitch, 'logAction');
    const input: DispatchInput = {
      ...BASE_INPUT,
      procedure: { ...PROCEDURE, adapter: { ...PROCEDURE.adapter, executor: 'service:preset' } },
    };
    const result = await dispatchProcedure(input);
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('serviceRecording');
    expect(logSpy).toHaveBeenCalledWith(
      'test-agent',
      'procedure_dispatcher:service_missing_recording',
      true
    );
  });

  it('executes an approved desktop recording through the OS bridge', async () => {
    const redact = vi.fn(async () => undefined);
    const desktopRecording: DesktopRecording = {
      schema_version: 'desktop-recording.v1',
      recording_id: 'desktop-1',
      source: 'desktop-capture',
      created_at: '2026-08-09T00:00:00Z',
      target: { name: 'Notes', platform: 'darwin' },
      steps: [
        {
          step_id: 's1',
          op: 'screenshot',
          summary: 'observe',
          risk_class: 'read',
          selector: { app: 'Notes', window_title: 'Note' },
          evidence: ['active_window:window_title'],
        },
      ],
      risk_summary: { requires_manual_review: true, approval_required_count: 0 },
      recording_hash: '',
      policy_version: 'v1',
      review: { status: 'approved', reviewer: 'operator', reviewed_at: '2026-08-09T00:00:00Z' },
    };
    const desktopIntent = approveDesktopIntent(desktopRecording);
    const input: DispatchInput = {
      ...BASE_INPUT,
      procedure: {
        ...PROCEDURE,
        pipeline_ref: 'pipelines/desktop/test-desktop-1.json',
        adapter: {
          ...PROCEDURE.adapter,
          executor: 'system',
          recording_ref: 'active/shared/runtime/recordings/desktop-1.json',
        },
      },
      desktopRecording,
      desktopIntent,
      desktopPipeline: desktopPipeline(
        {
          ...PROCEDURE,
          procedure_id: PROCEDURE.procedure_id,
          pipeline_ref: 'pipelines/desktop/test-desktop-1.json',
          adapter: {
            ...PROCEDURE.adapter,
            executor: 'system',
            recording_ref: 'active/shared/runtime/recordings/desktop-1.json',
          },
        },
        desktopRecording
      ),
      desktopBridge: {
        getWindowList: () => ['Note'],
        detectFocusedInput: () => ({
          application: 'Notes',
          windowTitle: 'Note',
          role: '',
          description: '',
          editable: false,
        }),
        takeScreenshot: () => ({ path: 'withheld' }),
      },
      desktopScreenRedactor: redact,
    };
    const result = await dispatchProcedure(input);
    expect(result.status).toBe('executed');
    expect(redact).toHaveBeenCalledWith(
      expect.stringContaining('/active/shared/tmp/desktop-screenshots/raw-'),
      expect.stringContaining('/active/shared/tmp/desktop-screenshots/desktop-1-s1-')
    );
  });

  it('requires approval before a destructive desktop operation', async () => {
    const desktopRecording: DesktopRecording = {
      schema_version: 'desktop-recording.v1',
      recording_id: 'desktop-2',
      source: 'desktop-capture',
      created_at: '2026-08-09T00:00:00Z',
      target: { name: 'Notes', platform: 'darwin' },
      steps: [
        {
          step_id: 's1',
          op: 'app_quit',
          summary: 'quit',
          risk_class: 'high',
          selector: { app: 'Notes' },
          evidence: ['active_window:application'],
        },
      ],
      risk_summary: { requires_manual_review: true, approval_required_count: 1 },
      recording_hash: '',
      policy_version: 'v1',
      review: { status: 'approved', reviewer: 'operator', reviewed_at: '2026-08-09T00:00:00Z' },
    };
    const desktopIntent = approveDesktopIntent(desktopRecording);
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: {
        ...PROCEDURE,
        pipeline_ref: 'pipelines/desktop/test-desktop-2.json',
        adapter: {
          ...PROCEDURE.adapter,
          executor: 'system',
          recording_ref: 'active/shared/runtime/recordings/desktop-2.json',
        },
      },
      desktopRecording,
      desktopIntent,
      desktopPipeline: desktopPipeline(
        {
          ...PROCEDURE,
          pipeline_ref: 'pipelines/desktop/test-desktop-2.json',
          adapter: {
            ...PROCEDURE.adapter,
            executor: 'system',
            recording_ref: 'active/shared/runtime/recordings/desktop-2.json',
          },
        },
        desktopRecording
      ),
      desktopBridge: {
        getWindowList: () => ['Note'],
        detectFocusedInput: () => ({
          application: 'Notes',
          windowTitle: 'Note',
          role: '',
          description: '',
          editable: false,
        }),
        quitApplication: vi.fn(),
      },
    });
    expect(result.status).toBe('approval_required');
  });

  it('blocks an approved recording whose contents were changed after review', async () => {
    const desktopRecording: DesktopRecording = {
      schema_version: 'desktop-recording.v1',
      recording_id: 'desktop-3',
      source: 'desktop-capture',
      created_at: '2026-08-09T00:00:00Z',
      target: { name: 'Notes', platform: 'darwin' },
      steps: [
        {
          step_id: 's1',
          op: 'screenshot',
          summary: 'observe',
          risk_class: 'read',
          selector: { app: 'Notes', window_title: 'Note' },
          evidence: ['active_window:window_title'],
        },
      ],
      risk_summary: { requires_manual_review: true, approval_required_count: 0 },
      recording_hash: 'reviewed-hash',
      policy_version: 'v1',
      review: { status: 'approved', reviewer: 'operator', reviewed_at: '2026-08-09T00:00:00Z' },
    };
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: {
        ...PROCEDURE,
        pipeline_ref: 'pipelines/desktop/test-desktop-3.json',
        adapter: {
          ...PROCEDURE.adapter,
          executor: 'system',
          recording_ref: 'active/shared/runtime/recordings/desktop-3.json',
        },
      },
      desktopRecording,
      desktopPipeline: desktopPipeline(
        {
          ...PROCEDURE,
          pipeline_ref: 'pipelines/desktop/test-desktop-3.json',
          adapter: {
            ...PROCEDURE.adapter,
            executor: 'system',
            recording_ref: 'active/shared/runtime/recordings/desktop-3.json',
          },
        },
        desktopRecording
      ),
      desktopBridge: {
        getWindowList: () => ['Note'],
        detectFocusedInput: () => ({
          application: 'Notes',
          windowTitle: 'Note',
          role: '',
          description: '',
          editable: false,
        }),
      },
    });
    expect(result).toMatchObject({
      status: 'blocked',
      errors: [expect.stringContaining('recording_hash')],
    });
  });

  it('blocks a desktop procedure when its persisted pipeline does not bind the recording', async () => {
    const desktopRecording: DesktopRecording = {
      schema_version: 'desktop-recording.v1',
      recording_id: 'desktop-4',
      source: 'desktop-capture',
      created_at: '2026-08-09T00:00:00Z',
      target: { name: 'Notes', platform: 'darwin' },
      steps: [
        {
          step_id: 's1',
          op: 'screenshot',
          summary: 'observe',
          risk_class: 'read',
          selector: { app: 'Notes' },
          evidence: ['active_window:application'],
        },
      ],
      risk_summary: { requires_manual_review: true, approval_required_count: 0 },
      recording_hash: '',
      policy_version: 'v1',
      review: { status: 'approved', reviewer: 'operator', reviewed_at: '2026-08-09T00:00:00Z' },
    };
    desktopRecording.recording_hash = computeDesktopRecordingHash(desktopRecording);
    const procedure = {
      ...PROCEDURE,
      pipeline_ref: 'pipelines/desktop/test-desktop-4.json',
      adapter: {
        ...PROCEDURE.adapter,
        executor: 'system',
        recording_ref: 'active/shared/runtime/recordings/desktop-4.json',
      },
    };
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure,
      desktopRecording,
      desktopPipeline: {
        ...desktopPipeline(procedure, desktopRecording),
        recording_hash: 'a'.repeat(64),
      },
    });
    expect(result).toMatchObject({
      status: 'blocked',
      errors: [expect.stringContaining('recording_hash')],
    });
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
    const logSpy = vi.spyOn(killSwitch.killSwitch, 'logAction');
    const result = await dispatchProcedure({ ...BASE_INPUT, recording: undefined });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('recording');
    expect(logSpy).toHaveBeenCalledWith(
      'test-agent',
      'procedure_dispatcher:missing_recording',
      true
    );
  });

  it('returns blocked when session is missing', async () => {
    const logSpy = vi.spyOn(killSwitch.killSwitch, 'logAction');
    const result = await dispatchProcedure({ ...BASE_INPUT, session: undefined });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('session');
    expect(logSpy).toHaveBeenCalledWith('test-agent', 'procedure_dispatcher:missing_session', true);
  });

  it('returns blocked when recording origin is not in procedure allowed origins', async () => {
    const logSpy = vi.spyOn(killSwitch.killSwitch, 'logAction');
    const wrongOriginRecording: BrowserExtensionRecording = {
      ...RECORDING,
      tab: { ...RECORDING.tab, origin: 'https://trusted.example.com.evil' },
    };
    const result = await dispatchProcedure({ ...BASE_INPUT, recording: wrongOriginRecording });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('trusted.example.com.evil');
    expect(result.errors[0]).toContain('not in allowed origins');
    expect(logSpy).toHaveBeenCalledWith(
      'test-agent',
      'procedure_dispatcher:origin_blocked:attendance.approve.kingoftime',
      true
    );
  });

  it('issues one origin-bound lease per segment for a multi-origin recording', async () => {
    // preflight internals are covered by their own suite; mock to ready so this
    // test focuses on the dispatcher's segmentation + per-segment lease wiring.
    vi.spyOn(bridge, 'preflightBrowserExtensionSession').mockReturnValue({
      status: 'ready_for_review',
      errors: [],
      approvalRequired: false,
      approvedStepHashes: [],
    });
    const multiOrigin: ProcedureEntry = {
      ...PROCEDURE,
      target: {
        ...PROCEDURE.target,
        origins: ['https://s2.kingtime.jp', 'https://news.yahoo.co.jp'],
      },
    };
    const segmentedRecording: BrowserExtensionRecording = {
      ...RECORDING,
      actions: [
        {
          action_id: 'act-1',
          op: 'snapshot',
          summary: 'observe kingtime',
          risk: 'observe',
          captured_at: '2026-06-24T00:00:00Z',
        },
        {
          action_id: 'nav-1',
          op: 'navigate',
          summary: 'handoff',
          risk: 'observe',
          captured_at: '2026-06-24T00:00:01Z',
          navigation: {
            from_origin: 'https://s2.kingtime.jp',
            to_origin: 'https://news.yahoo.co.jp',
          },
        },
        {
          action_id: 'act-2',
          op: 'snapshot',
          summary: 'observe news',
          risk: 'observe',
          captured_at: '2026-06-24T00:00:02Z',
        },
      ],
      review: {
        status: 'approved',
        reviewed_at: '2026-06-24T00:00:03Z',
        decisions: [
          { action_id: 'act-1', status: 'approved' },
          { action_id: 'nav-1', status: 'approved' },
          { action_id: 'act-2', status: 'approved' },
        ],
      },
    };
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: multiOrigin,
      recording: segmentedRecording,
    });
    expect(result.status).toBe('lease_issued');
    expect(result.segments).toHaveLength(2);
    expect(result.segments?.map((s) => s.origin)).toEqual([
      'https://s2.kingtime.jp',
      'https://news.yahoo.co.jp',
    ]);
    expect(result.segments?.[0].lease.origin).toBe('https://s2.kingtime.jp');
    expect(result.segments?.[1].lease.segment_index).toBe(1);
    expect(result.lease).toBeUndefined();
  });

  it('blocks a multi-origin recording whose segment origin is not in the procedure allowlist', async () => {
    const segmentedRecording: BrowserExtensionRecording = {
      ...RECORDING,
      actions: [
        {
          action_id: 'nav-1',
          op: 'navigate',
          summary: 'handoff',
          risk: 'observe',
          captured_at: '2026-06-24T00:00:01Z',
          navigation: {
            from_origin: 'https://s2.kingtime.jp',
            to_origin: 'https://evil.example.com',
          },
        },
      ],
    };
    // PROCEDURE only allows kingtime; the news/evil segment origin is not allowed.
    const result = await dispatchProcedure({ ...BASE_INPUT, recording: segmentedRecording });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('evil.example.com');
  });

  it('returns approval_required when approval gate blocks', async () => {
    const logSpy = vi.spyOn(killSwitch.killSwitch, 'logAction');
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
    expect(logSpy).toHaveBeenCalledWith(
      'test-agent',
      'procedure_dispatcher:approval_required:attendance.approve.kingoftime',
      true
    );
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
      })
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
// dispatchProcedure — playwright substrate (execution_substrate: 'playwright')
// ---------------------------------------------------------------------------

describe('dispatchProcedure — playwright substrate', () => {
  afterEach(() => vi.restoreAllMocks());

  const PLAYWRIGHT_PROCEDURE: ProcedureEntry = {
    ...PROCEDURE,
    execution_substrate: 'playwright',
  };

  const HEX64 = 'a'.repeat(64);

  const CLICK_RECORDING: BrowserExtensionRecording = {
    ...RECORDING,
    tab: { ...RECORDING.tab, origin_hash: HEX64 },
    actions: [
      {
        action_id: 'act-1',
        op: 'click_ref',
        summary: 'Approve',
        risk: 'low',
        captured_at: '2026-06-24T00:00:00Z',
        target: {
          ref: '@e1',
          role: 'button',
          name: 'Approve',
          snapshot_hash: HEX64,
        },
      },
    ],
    review: {
      status: 'approved',
      reviewed_at: '2026-06-24T00:00:01Z',
      decisions: [{ action_id: 'act-1', status: 'approved' }],
    },
  };

  it('routes execution_substrate=playwright to the playwright executor without touching the extension_session path', async () => {
    const executeBrowserPipeline = vi.fn().mockResolvedValue({ status: 'succeeded', results: [] });
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: PLAYWRIGHT_PROCEDURE,
      recording: CLICK_RECORDING,
      executeBrowserPipeline,
    });
    expect(result.status).toBe('executed');
    expect(executeBrowserPipeline).toHaveBeenCalledTimes(1);
    const call = executeBrowserPipeline.mock.calls[0][0];
    expect(call.steps[0].op).toBe('click_ref');
    expect(call.steps[0].params.ref).toBe('@e1');
  });

  it('returns approval_required for high-risk actions, identically to the extension path', async () => {
    const highRiskRecording: BrowserExtensionRecording = {
      ...CLICK_RECORDING,
      actions: [{ ...CLICK_RECORDING.actions[0], op: 'delete', risk: 'high' }],
      review: {
        status: 'approved',
        reviewed_at: '2026-06-24T00:00:01Z',
        decisions: [{ action_id: 'act-1', status: 'approved' }],
      },
    };
    vi.spyOn(bridge, 'enforceBrowserExtensionApproval').mockReturnValue({
      allowed: false,
      status: 'pending',
      requestId: 'REQ-PW-1',
      message: 'Pending approval',
    });
    const executeBrowserPipeline = vi.fn();
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: PLAYWRIGHT_PROCEDURE,
      recording: highRiskRecording,
      executeBrowserPipeline,
    });
    expect(result.status).toBe('approval_required');
    expect(result.approvalRequestId).toBe('REQ-PW-1');
    expect(executeBrowserPipeline).not.toHaveBeenCalled();
  });

  it('returns blocked when no executeBrowserPipeline is injected', async () => {
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: PLAYWRIGHT_PROCEDURE,
      recording: CLICK_RECORDING,
    });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('executeBrowserPipeline');
  });

  it('returns blocked when the recording review is not approved', async () => {
    const unapproved: BrowserExtensionRecording = {
      ...CLICK_RECORDING,
      review: { status: 'pending', decisions: [] },
    };
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: PLAYWRIGHT_PROCEDURE,
      recording: unapproved,
      executeBrowserPipeline: vi.fn(),
    });
    expect(result.status).toBe('blocked');
    expect(result.errors[0]).toContain('approved recording review');
  });

  it('returns blocked when the browser-actuator reports a failed step', async () => {
    const executeBrowserPipeline = vi
      .fn()
      .mockResolvedValue({ status: 'failed', results: [], errors: ['click_ref failed for @e1'] });
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: PLAYWRIGHT_PROCEDURE,
      recording: CLICK_RECORDING,
      executeBrowserPipeline,
    });
    expect(result.status).toBe('blocked');
    expect(result.errors).toContain('click_ref failed for @e1');
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
    expires_at: '2026-06-24T10:00:00Z', // expires exactly at `now`
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
    const result = extendLeaseForMfa({
      existingLease,
      recording: RECORDING,
      session: SESSION,
      now,
    });
    const expiresAt = Date.parse(result.lease!.expires_at);
    const diff = expiresAt - now.getTime();
    expect(diff).toBeCloseTo(10 * 60_000, -3); // within ~1s tolerance
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
    vi.spyOn(approvalGate, 'enforceApprovalGate').mockReturnValue({
      allowed: true,
      status: 'approved',
    });
    const result = await dispatchProcedure(baseInput());
    expect(result.status).toBe('executed');
    expect(result.serviceResults?.[0]).toMatchObject({ step_id: 's1', status: 'done' });
  });

  it('returns approval_required when the external-effect gate blocks', async () => {
    vi.spyOn(approvalGate, 'enforceApprovalGate').mockReturnValue({
      allowed: false,
      status: 'pending',
      requestId: 'REQ-9',
    });
    const result = await dispatchProcedure(baseInput());
    expect(result.status).toBe('approval_required');
    expect(result.approvalRequestId).toBe('REQ-9');
  });

  it('runs read-only recordings without invoking the approval gate', async () => {
    const spy = vi.spyOn(approvalGate, 'enforceApprovalGate');
    const readOnly = serviceRecording({
      steps: [
        {
          step_id: 'r1',
          service_id: 'jira',
          action: 'search',
          summary: '検索',
          risk_class: 'read',
        },
      ],
      risk_summary: { requires_manual_review: true, approval_required_count: 0 },
      review: { status: 'approved', decisions: [{ step_id: 'r1', status: 'approved' }] },
    });
    const result = await dispatchProcedure({ ...baseInput(), serviceRecording: readOnly });
    expect(result.status).toBe('executed');
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks a step whose service is not in the procedure allowlist', async () => {
    const offlist = serviceRecording({
      target: { name: 'Deal Intake', services: ['box'] },
      steps: [
        { step_id: 's1', service_id: 'box', action: 'upload', summary: 'x', risk_class: 'high' },
      ],
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

  it('blocks an approved recording whose review decisions do not match its steps', async () => {
    const malformed = serviceRecording({
      review: {
        status: 'approved',
        decisions: [
          { step_id: 's1', status: 'approved' },
          { step_id: 'unknown', status: 'approved' },
        ],
      },
    });
    const result = await dispatchProcedure({ ...baseInput(), serviceRecording: malformed });
    expect(result.status).toBe('blocked');
    expect(result.errors.join(' ')).toContain('unknown step unknown');
  });
});

describe('procedure executor registry (RS-07)', () => {
  it('registers adapter executors and execution-substrate routes as data', async () => {
    const { listProcedureExecutors, listProcedureExecutionSubstrateRoutes } =
      await import('./procedure-dispatcher.js');
    expect(listProcedureExecutors().sort()).toEqual(
      ['extension_session', 'media:pipeline', 'service:preset', 'system'].sort()
    );
    expect(listProcedureExecutionSubstrateRoutes()).toEqual(['browser:playwright']);
  });

  it('fails closed for an unregistered executor (including prototype keys)', async () => {
    const { dispatchProcedure } = await import('./procedure-dispatcher.js');
    for (const executor of ['carrier-pigeon', 'toString']) {
      const result = await dispatchProcedure({
        procedure: {
          substrate: 'browser',
          adapter: { executor },
        } as unknown as ProcedureEntry,
        agentId: 'test-agent',
        missionId: 'MSN-TEST',
      });
      expect(result.status).toBe('blocked');
      expect(result.errors[0]).toContain(`Unknown executor: "${executor}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchProcedure — golden-scenario verdicts on executed runs
// ---------------------------------------------------------------------------

describe('dispatchProcedure — golden-scenario verdicts', () => {
  const root = pathResolver.sharedTmp(`dispatcher-golden-${process.pid}`);
  const feedbackDir = pathResolver.sharedTmp(`dispatcher-golden-feedback-${process.pid}`);
  const recordingRef = pathResolver.toRepoRelative(path.join(root, 'recording.json'));
  let savedFeedbackDir: string | undefined;

  beforeEach(() => {
    savedFeedbackDir = process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR;
    process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = feedbackDir;
    safeMkdir(root, { recursive: true });
    safeWriteFile(path.join(root, 'recording.json'), '{"recording":"v1"}\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedFeedbackDir === undefined) delete process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR;
    else process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = savedFeedbackDir;
    safeRmSync(root, { recursive: true, force: true });
    safeRmSync(feedbackDir, { recursive: true, force: true });
  });

  function withGolden(
    procedure: ProcedureEntry,
    conditions: GoldenScenario['success_conditions']
  ): ProcedureEntry {
    const goldenRef = saveGoldenScenario(
      {
        schema_version: 'golden-scenario.v1',
        scenario_id: `gs-${procedure.procedure_id}`,
        procedure_id: procedure.procedure_id,
        success_conditions: conditions,
        captured_from: 'rec-1',
        version: '1.0.0',
      },
      path.join(root, 'golden', `${procedure.procedure_id}.json`)
    );
    return {
      ...procedure,
      adapter: { ...procedure.adapter, recording_ref: recordingRef },
      golden_scenario_ref: goldenRef,
    };
  }

  const ledgerState = () => resolveKnowledgeVerification([recordingRef]).get(recordingRef);

  it('passes a service run that produced what the golden scenario names, and records it', async () => {
    vi.spyOn(approvalGate, 'enforceApprovalGate').mockReturnValue({
      allowed: true,
      status: 'approved',
    });
    const result = await dispatchProcedure({
      procedure: withGolden(SERVICE_PROCEDURE, [
        {
          kind: 'response_field',
          params: { channel: 'issue_key', service_id: 'jira', action: 'create_issue' },
        },
      ]),
      agentId: 'test-agent',
      missionId: 'msn-1',
      serviceRecording: serviceRecording(),
      executePreset: async () => ({ issue_key: 'JIRA-1' }),
    });
    expect(result.status).toBe('executed');
    expect(result.golden?.verdict).toBe('pass');
    expect(ledgerState()).toMatchObject({ state: 'verified', evidence: 'golden' });
  });

  it('fails a service run whose producing step errored, and records a failed check', async () => {
    vi.spyOn(approvalGate, 'enforceApprovalGate').mockReturnValue({
      allowed: true,
      status: 'approved',
    });
    const result = await dispatchProcedure({
      procedure: withGolden(SERVICE_PROCEDURE, [
        { kind: 'response_field', params: { channel: 'issue_key' } },
      ]),
      agentId: 'test-agent',
      missionId: 'msn-1',
      serviceRecording: serviceRecording(),
      executePreset: async () => {
        throw new Error('jira 503');
      },
    });
    expect(result.golden?.verdict).toBe('fail');
    expect(ledgerState()).toMatchObject({
      state: 'reported_problem',
      last_problem_kind: 'failed_check',
    });
  });

  const PLAYWRIGHT: ProcedureEntry = { ...PROCEDURE, execution_substrate: 'playwright' };
  const CLICK: BrowserExtensionRecording = {
    ...RECORDING,
    tab: { ...RECORDING.tab, origin_hash: 'a'.repeat(64) },
    actions: [
      {
        action_id: 'act-1',
        op: 'click_ref',
        summary: 'Approve',
        risk: 'low',
        captured_at: '2026-06-24T00:00:00Z',
        target: { ref: '@e1', role: 'button', name: 'Approve', snapshot_hash: 'a'.repeat(64) },
      },
    ],
    review: {
      status: 'approved',
      reviewed_at: '2026-06-24T00:00:01Z',
      decisions: [{ action_id: 'act-1', status: 'approved' }],
    },
  };
  const approvedBanner = [
    { kind: 'ref_visible' as const, role: 'status', name_contains: 'Approved' },
  ];
  const runPlaywright = (context: unknown) =>
    dispatchProcedure({
      ...BASE_INPUT,
      procedure: withGolden(PLAYWRIGHT, approvedBanner),
      recording: CLICK,
      executeBrowserPipeline: vi
        .fn()
        .mockResolvedValue({ status: 'succeeded', results: [], context }),
    });

  it('checks a playwright run against the page it ended on', async () => {
    const pass = await runPlaywright({
      golden_final_snapshot: {
        elements: [{ role: 'status', name: 'Request Approved', text: '', visible: true }],
      },
    });
    expect(pass.golden?.verdict).toBe('pass');

    const fail = await runPlaywright({
      golden_final_snapshot: {
        elements: [{ role: 'alert', name: 'Session expired', text: '', visible: true }],
      },
    });
    expect(fail.status).toBe('executed');
    expect(fail.golden?.verdict).toBe('fail');
  });

  it('appends one read-only final snapshot and ignores any earlier last_snapshot', async () => {
    const executeBrowserPipeline = vi.fn().mockResolvedValue({
      status: 'succeeded',
      results: [],
      // A snapshot an earlier step took before the final click: not evidence.
      context: {
        last_snapshot: { elements: [{ role: 'status', name: 'Request Approved', visible: true }] },
      },
    });
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: withGolden(PLAYWRIGHT, approvedBanner),
      recording: CLICK,
      executeBrowserPipeline,
    });
    const steps = executeBrowserPipeline.mock.calls[0][0].steps;
    expect(steps.at(-1)).toMatchObject({
      type: 'capture',
      op: 'snapshot',
      params: { export_as: 'golden_final_snapshot' },
    });
    expect(steps).toHaveLength(2);
    expect(result.golden?.verdict).toBe('inconclusive');
  });

  it('is inconclusive, and records nothing, when the run returned no page snapshot', async () => {
    const result = await runPlaywright(undefined);
    expect(result.golden?.verdict).toBe('inconclusive');
    expect(ledgerState()).toBeUndefined();
  });

  it('runs exactly as before for a procedure without a golden scenario', async () => {
    const executeBrowserPipeline = vi.fn().mockResolvedValue({ status: 'succeeded', results: [] });
    const result = await dispatchProcedure({
      ...BASE_INPUT,
      procedure: PLAYWRIGHT,
      recording: CLICK,
      executeBrowserPipeline,
    });
    expect(result.status).toBe('executed');
    expect(result.golden).toBeUndefined();
    expect(executeBrowserPipeline.mock.calls[0][0].steps).toHaveLength(1);
  });
});
