// HT-03 (2nd half): `hearing-mission-routes.ts` route wiring + behavior, in
// the style of `hearing-routes.test.ts` (fake `express.Express` that only
// records handlers by `METHOD path`; the real `resolvePresenceStudioViewerContext`
// / `hearing-runtime.ts` helpers seed and read fixtures on disk under a
// dedicated fictitious tenant namespace, removed in `afterEach`).
//
// `safeExecResult` (the mission_controller.js / mission_alignment_request.js
// subprocess boundary), `findMissionPath`, and `loadState` are mocked so
// this file never actually spawns a process or depends on a real mission
// directory; `resolveMemberByPrincipal` is mocked the same way
// `hearing-routes.test.ts` mocks it, for the same hermeticity reason.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile, safeRmSync } from '@agent/core';
import type express from 'express';

vi.mock('@agent/core/member-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/member-registry')>(
    '@agent/core/member-registry'
  );
  return { ...actual, resolveMemberByPrincipal: vi.fn() };
});

vi.mock('@agent/core/secure-io', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  return { ...actual, safeExecResult: vi.fn() };
});

vi.mock('@agent/core/path-resolver', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/path-resolver')>(
    '@agent/core/path-resolver'
  );
  return { ...actual, findMissionPath: vi.fn() };
});

vi.mock('@agent/core/mission-state', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/mission-state')>(
    '@agent/core/mission-state'
  );
  return { ...actual, loadState: vi.fn() };
});

vi.mock('@agent/core/approval-store', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/approval-store')>(
    '@agent/core/approval-store'
  );
  return { ...actual, listApprovalRequests: vi.fn() };
});

import { resolveMemberByPrincipal } from '@agent/core/member-registry';
import { safeExecResult } from '@agent/core/secure-io';
import { findMissionPath } from '@agent/core/path-resolver';
import { loadState } from '@agent/core/mission-state';
import type { MissionState } from '@agent/core/mission-types';
import { listApprovalRequests } from '@agent/core/approval-store';
import { applyHearingTurn, createHearingRecord, type HearingRecord } from './hearing.js';
import { hearingNamespace, loadHearingRecord, saveHearingRecord } from './hearing-runtime.js';
import { hearingMissionId, type MissionBrief } from './hearing-mission.js';
import {
  registerHearingMissionRoutes,
  type HearingRecordWithMissionHandoff,
} from './hearing-mission-routes.js';

type Handler = (req: unknown, res: unknown) => void;

function createFakeApp(): { app: express.Express; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const fake = {
    post(routePath: string, handler: Handler) {
      handlers.set(`POST ${routePath}`, handler);
    },
  };
  return { app: fake as unknown as express.Express, handlers };
}

function fakeRequest(overrides: {
  params?: Record<string, string>;
  query?: Record<string, string>;
}) {
  const urlPath = '/api/hearing/test/handoff';
  return {
    params: overrides.params || {},
    query: overrides.query || {},
    body: {},
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    path: urlPath,
    originalUrl: urlPath,
    url: urlPath,
  } as never;
}

function fakeResponse() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (code: number) => typeof res;
    json: (body: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const TEST_TENANT = 'zz-hearing-mission-route-test';
const TEST_MEMBER_ID = 'zz-hearing-mission-member';

function fixtureMember(role: 'owner' | 'approver' | 'viewer' = 'approver') {
  return {
    member_id: TEST_MEMBER_ID,
    display_name: 'ZZ Mission Tester',
    status: 'active' as const,
    memberships: [{ tenant_slug: TEST_TENANT, role }],
    access_registrations: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const REQUIREMENT_ANSWERS: Record<string, string> = {
  audience: 'Small clinics',
  problem: 'Staff double-book appointment slots',
  core_flow: 'Pick a slot, confirm by SMS',
  content: 'Calendar grid and contact card',
  visual_direction: 'Calm and clinical',
  constraints: 'Must work offline at first',
  success: 'No more double-booked slots',
};

function fullyAnsweredRecord(sessionId: string): HearingRecord {
  let record = createHearingRecord(sessionId, '2026-09-14T00:00:00.000Z');
  for (const item of record.requirements) {
    record = applyHearingTurn(
      record,
      { text: REQUIREMENT_ANSWERS[item.id] || `answer ${item.id}`, request_id: `turn-${item.id}` },
      '2026-09-14T00:01:00.000Z'
    );
  }
  return record;
}

function decidedRecord(sessionId: string): HearingRecord {
  return {
    ...fullyAnsweredRecord(sessionId),
    decided_by: {
      kind: 'human',
      id: `user:${TEST_MEMBER_ID}`,
      display_name: 'ZZ Mission Tester',
      role: 'approver',
    },
    decided_at: '2026-09-14T00:02:00.000Z',
  };
}

describe('hearing-mission-routes.ts route wiring', () => {
  it('registers POST /api/hearing/:session/handoff', () => {
    const { app, handlers } = createFakeApp();
    registerHearingMissionRoutes(app);
    expect(handlers.has('POST /api/hearing/:session/handoff')).toBe(true);
  });

  it('server.ts registers the handoff route right after registerHearingRoutes', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('presence/displays/presence-studio/server.ts'), {
        encoding: 'utf8',
      })
    );
    const hearingCall = source.indexOf('registerHearingRoutes(presenceStudioData.app)');
    const handoffCall = source.indexOf('registerHearingMissionRoutes(presenceStudioData.app)');
    const trainingCall = source.indexOf('registerTrainingRoutes(presenceStudioData.app)');
    expect(hearingCall).toBeGreaterThan(-1);
    expect(handoffCall).toBeGreaterThan(hearingCall);
    expect(trainingCall).toBeGreaterThan(handoffCall);
  });
});

describe('POST /api/hearing/:session/handoff', () => {
  let savedTenant: string | undefined;
  const { app, handlers } = createFakeApp();
  registerHearingMissionRoutes(app);
  const handoff = handlers.get('POST /api/hearing/:session/handoff')!;
  const namespace = hearingNamespace([TEST_TENANT]);

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    process.env.KYBERION_TENANT = TEST_TENANT;
    vi.mocked(resolveMemberByPrincipal).mockReset();
    vi.mocked(safeExecResult).mockReset();
    vi.mocked(findMissionPath).mockReset();
    vi.mocked(loadState).mockReset();
    vi.mocked(listApprovalRequests).mockReset();
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    safeRmSync(pathResolver.sharedTmp(`hearing/${TEST_TENANT}`), { recursive: true, force: true });
    safeRmSync(pathResolver.sharedTmp('hearing-mission-routes-test'), {
      recursive: true,
      force: true,
    });
  });

  it('refuses with 409 when no hearing record exists yet', () => {
    const sessionId = `sess-${randomUUID()}`;
    const res = fakeResponse();
    handoff(fakeRequest({ params: { session: sessionId } }), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { ok: boolean }).ok).toBe(false);
    expect(resolveMemberByPrincipal).not.toHaveBeenCalled();
  });

  it('refuses with 403 when no member resolves for the viewer', () => {
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(null);
    const sessionId = `sess-${randomUUID()}`;
    saveHearingRecord(namespace, decidedRecord(sessionId));

    const res = fakeResponse();
    handoff(fakeRequest({ params: { session: sessionId } }), res);
    expect(res.statusCode).toBe(403);
    expect(safeExecResult).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the record has not been decided yet', () => {
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember());
    const sessionId = `sess-${randomUUID()}`;
    saveHearingRecord(namespace, fullyAnsweredRecord(sessionId));

    const res = fakeResponse();
    handoff(fakeRequest({ params: { session: sessionId } }), res);
    expect(res.statusCode).toBe(409);
    expect(safeExecResult).not.toHaveBeenCalled();
  });

  it('fails when the controller reports success but the mission never lands on disk', () => {
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember());
    vi.mocked(safeExecResult).mockReturnValue({ stdout: '', stderr: '', status: 0 });
    vi.mocked(findMissionPath).mockReturnValue(null);
    vi.mocked(loadState).mockReturnValue(null);

    const sessionId = `sess-${randomUUID()}`;
    saveHearingRecord(namespace, decidedRecord(sessionId));

    const res = fakeResponse();
    handoff(fakeRequest({ params: { session: sessionId } }), res);
    expect(res.statusCode).toBe(502);
    const persisted = loadHearingRecord(namespace, sessionId) as HearingRecordWithMissionHandoff;
    expect(persisted.mission_id).toBeUndefined();
  });

  it('creates the mission, writes the brief evidence, opens the alignment request, and is idempotent on a second call', () => {
    const sessionId = `sess-${randomUUID()}`;
    const record = decidedRecord(sessionId);
    saveHearingRecord(namespace, record);
    const missionId = hearingMissionId(record);
    const missionDir = pathResolver.sharedTmp(`hearing-mission-routes-test/${missionId}`);

    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember());
    vi.mocked(findMissionPath).mockReturnValue(missionDir);
    vi.mocked(loadState).mockReturnValue({ status: 'planned' } as unknown as MissionState);
    vi.mocked(safeExecResult).mockImplementation((_command: string, args: string[] = []) => {
      if (args[0] === 'dist/scripts/mission_controller.js') {
        return { stdout: '', stderr: '', status: 0 };
      }
      return {
        stdout: JSON.stringify({
          missionId,
          created: true,
          requestId: 'REQ-ALIGN-1',
          payloadHash: 'deadbeef',
          briefPath: `${missionDir}/evidence/mission-brief.json`,
        }),
        stderr: '',
        status: 0,
      };
    });

    const res = fakeResponse();
    handoff(fakeRequest({ params: { session: sessionId } }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      mission_id: string;
      approval_request_id: string;
      next_action: { kind: string; label_key: string; href: string };
    };
    expect(body.ok).toBe(true);
    expect(body.mission_id).toBe(missionId);
    expect(body.approval_request_id).toBe('REQ-ALIGN-1');
    expect(body.next_action.kind).toBe('alignment_review');
    expect(body.next_action.label_key).toBe('front_desk:hearing_open_decide');
    expect(body.next_action.href).toContain('/');

    // (a) create argv shape
    const createCall = vi.mocked(safeExecResult).mock.calls[0];
    expect(createCall[1]).toEqual([
      'dist/scripts/mission_controller.js',
      'create',
      missionId,
      '--tier',
      'confidential',
      '--tenant-slug',
      TEST_TENANT,
      '--goal',
      REQUIREMENT_ANSWERS.problem,
      '--success-condition',
      REQUIREMENT_ANSWERS.success,
      '--decided-by',
      `user:${TEST_MEMBER_ID}`,
      '--decided-by-name',
      'ZZ Mission Tester',
      '--decided-by-role',
      'approver',
    ]);

    // (d) alignment request argv shape
    const alignmentCall = vi.mocked(safeExecResult).mock.calls[1];
    expect(alignmentCall[1]).toEqual([
      'dist/scripts/mission_alignment_request.js',
      '--mission',
      missionId,
      '--json',
    ]);

    // (c) brief written to <missionDir>/evidence/mission-brief.json
    const briefRaw = String(
      safeReadFile(`${missionDir}/evidence/mission-brief.json`, { encoding: 'utf8' })
    );
    const brief = JSON.parse(briefRaw) as MissionBrief;
    expect(brief.missionId).toBe(missionId);
    expect(brief.title).toBe(REQUIREMENT_ANSWERS.problem);

    // (e) hearing record updated
    const persisted = loadHearingRecord(namespace, sessionId) as HearingRecordWithMissionHandoff;
    expect(persisted.mission_id).toBe(missionId);
    expect(persisted.approval_request_id).toBe('REQ-ALIGN-1');
    expect(typeof persisted.handed_off_at).toBe('string');

    // Idempotent: a second call returns the same ids without spawning again.
    vi.mocked(safeExecResult).mockClear();
    const res2 = fakeResponse();
    handoff(fakeRequest({ params: { session: sessionId } }), res2);
    expect(res2.statusCode).toBe(200);
    expect((res2.body as { mission_id: string }).mission_id).toBe(missionId);
    expect(safeExecResult).not.toHaveBeenCalled();
  });
});
