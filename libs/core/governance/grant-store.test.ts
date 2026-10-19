import { revokeStandingEffectApproval } from './approval-revocation.js';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '../storage-layout.js';
import { writeGovernedArtifactJson } from '../workforce/artifact-store.js';
import { auditChain } from './audit-chain.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from './approval-store.js';
import {
  GRANT_APPROVAL_CHANNEL,
  GrantError,
  grantRecordPath,
  grantStanding,
  grantStandingDirect,
  listGrants,
  loadGrant,
  normalizeMeetingUrl,
  requestGrantApproval,
  revokeGrant,
  validateGrantRecord,
  type GrantDraft,
  type GrantRecord,
} from './grant-store.js';
import {
  readGrantMissionBindings,
  recordGrantMissionBinding,
  resolveGrant,
} from './grant-resolver.js';

const GRANTS_ROOT = pathResolver.rootResolve(PARTITIONED_RUNTIME_STATE_ROOTS.grants);
const MISSION_ID = 'MSN-GRANT-STORE-TEST';
const MISSION_DIR = path.join(pathResolver.rootDir(), 'active/missions/confidential', MISSION_ID);
const HUMAN = 'user:grant-test-owner';
const HUMAN_ACTOR = { kind: 'human' as const, id: HUMAN };
const approvalIds: string[] = [];

const draft: GrantDraft = {
  capability: 'meeting.recording',
  tenant_slug: 'acme',
  meeting_urls: ['HTTPS://Meet.Google.com/abc-defg-hij/?authuser=1#x'],
  meeting_series_ids: ['series-weekly'],
  purpose: 'weekly sync minutes',
  ttl_days: 30,
};

function approve(request: ApprovalRequestRecord, overrides: Record<string, unknown> = {}): void {
  decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision: 'approved',
    decidedBy: HUMAN,
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
    ...overrides,
  });
}

function approvedGrant(input: GrantDraft = draft, now?: Date): GrantRecord {
  const request = requestGrantApproval(input, { requester: { requestedBy: 'agent:requester' } });
  approvalIds.push(request.id);
  approve(request);
  return grantStanding(input, { approvalRequestId: request.id, ...(now ? { now } : {}) });
}

function writeMission(): void {
  safeMkdir(path.join(MISSION_DIR, 'evidence'), { recursive: true });
  safeWriteFile(
    path.join(MISSION_DIR, 'mission-state.json'),
    JSON.stringify({
      mission_id: MISSION_ID,
      tier: 'confidential',
      assigned_persona: 'ecosystem_architect',
    })
  );
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['MISSION_ROLE', 'KYBERION_PERSONA', 'KYBERION_SUDO']) {
    savedEnv[key] = process.env[key];
  }
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'ecosystem_architect';
  delete process.env.KYBERION_SUDO;
  safeRmSync(GRANTS_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  safeRmSync(GRANTS_ROOT, { recursive: true, force: true });
  safeRmSync(MISSION_DIR, { recursive: true, force: true });
  for (const id of approvalIds.splice(0)) {
    safeRmSync(approvalRequestLogicalPath(GRANT_APPROVAL_CHANNEL, id), { force: true });
  }
  safeRmSync(approvalEventLogicalPath(GRANT_APPROVAL_CHANNEL), { force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('normalizeMeetingUrl', () => {
  it('lowercases scheme and host, strips query, fragment and trailing slash', () => {
    expect(normalizeMeetingUrl('HTTPS://Meet.Google.COM/abc-defg-hij/?authuser=1#frag')).toBe(
      'https://meet.google.com/abc-defg-hij'
    );
    expect(normalizeMeetingUrl('https://zoom.us/j/123')).toBe('https://zoom.us/j/123');
    expect(normalizeMeetingUrl('https://zoom.us/')).toBe('https://zoom.us');
  });

  it('keeps path case and rejects non-http(s) or credentialed URLs', () => {
    expect(normalizeMeetingUrl('https://teams.microsoft.com/l/MeetUp-Join/AbC')).toBe(
      'https://teams.microsoft.com/l/MeetUp-Join/AbC'
    );
    expect(normalizeMeetingUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeMeetingUrl('https://user:pw@meet.google.com/x')).toBeNull();
    expect(normalizeMeetingUrl('not a url')).toBeNull();
  });
});

describe('grant store', () => {
  it('stores an approved grant under the tenant partition with an audit id and normalized scope', () => {
    const record = approvedGrant();
    expect(record.grant_id).toMatch(/^GRT-\d{8}-[a-f0-9]{12}$/);
    expect(record.audit_event_id).toBeTruthy();
    expect(record.scope).toEqual({
      tenant_slug: 'acme',
      meeting_series_ids: ['series-weekly'],
      meeting_urls: ['https://meet.google.com/abc-defg-hij'],
    });
    expect(record.basis?.approval_request_id).toBeTruthy();
    expect(record.granted_by).toEqual({ actor_id: HUMAN, role: 'sovereign', assurance: 'A1' });
    const file = grantRecordPath('acme', record.grant_id);
    expect(file.split(path.sep).join('/')).toContain('/runtime/grants/confidential/acme/');
    expect(loadGrant('acme', record.grant_id)).toEqual(record);
    expect(listGrants({ tenant_slug: 'acme' }).map((r) => r.grant_id)).toEqual([record.grant_id]);
  });

  it('rejects drafts that violate the capability policy', () => {
    expect(() =>
      requestGrantApproval(
        { ...draft, meeting_urls: [], meeting_series_ids: [] },
        {
          requester: { requestedBy: 'agent:x' },
        }
      )
    ).toThrow(/at least one meeting/);
    expect(() =>
      requestGrantApproval({ ...draft, ttl_days: 91 }, { requester: { requestedBy: 'agent:x' } })
    ).toThrow(/between 1 and 90/);
    expect(() =>
      requestGrantApproval(
        { ...draft, capability: 'meeting.voice' },
        {
          requester: { requestedBy: 'agent:x' },
        }
      )
    ).toThrow(/per_mission/);
    expect(() =>
      requestGrantApproval(
        { ...draft, tenant_slug: 'shared' },
        {
          requester: { requestedBy: 'agent:x' },
        }
      )
    ).toThrow(/invalid tenant slug/);
    expect(() =>
      requestGrantApproval(
        { ...draft, meeting_urls: ['ftp://x'] },
        {
          requester: { requestedBy: 'agent:x' },
        }
      )
    ).toThrow(/not an http/);
  });

  it('refuses a direct (approval-less) grant of an external_io capability', () => {
    expect(() => grantStandingDirect(draft)).toThrow(GrantError);
    expect(() => grantStandingDirect(draft)).toThrow(/approval_required/);
  });

  it('treats a stored record over the policy lifetime, without basis, or misplaced as absent', () => {
    const record = approvedGrant();
    const file = grantRecordPath('acme', record.grant_id);
    const tooLong = {
      ...record,
      expires_at: new Date(Date.parse(record.granted_at) + 91 * 86_400_000).toISOString(),
    };
    expect(validateGrantRecord(tooLong).errors.join(';')).toMatch(/exceeds 90 days/);
    safeWriteFile(file, JSON.stringify(tooLong));
    expect(loadGrant('acme', record.grant_id)).toBeNull();

    const { basis: _basis, ...noBasis } = record;
    expect(validateGrantRecord(noBasis).errors.join(';')).toMatch(/approval_request_id/);
    safeWriteFile(file, JSON.stringify(noBasis));
    expect(loadGrant('acme', record.grant_id)).toBeNull();

    safeWriteFile(file, '{ broken');
    expect(loadGrant('acme', record.grant_id)).toBeNull();
    expect(listGrants({ tenant_slug: 'acme' })).toEqual([]);

    // A record copied into another tenant's partition grants nothing there.
    const other = grantRecordPath('globex', record.grant_id);
    safeMkdir(path.dirname(other), { recursive: true });
    safeWriteFile(other, JSON.stringify(record));
    expect(loadGrant('globex', record.grant_id)).toBeNull();
  });

  it('revoke keeps the record, audits it, and refuses a second revoke', () => {
    const record = approvedGrant();
    const revoked = revokeGrant(record.grant_id, { by: HUMAN_ACTOR, reason: 'series ended' });
    expect(revoked.revoked?.by).toBe(HUMAN);
    expect(revoked.revoked?.audit_event_id).toBeTruthy();
    const stored = JSON.parse(
      String(safeReadFile(grantRecordPath('acme', record.grant_id), { encoding: 'utf8' }))
    );
    expect(stored.revoked.reason).toBe('series ended');
    expect(stored.audit_event_id).toBe(record.audit_event_id);
    expect(() => revokeGrant(record.grant_id, { by: HUMAN_ACTOR, reason: 'again' })).toThrow(
      /already revoked/
    );
    expect(() =>
      revokeGrant('GRT-20261019-000000000000', { by: HUMAN_ACTOR, reason: 'x' })
    ).toThrow(/not_found/);
  });
});

describe('grant approval flow', () => {
  it('rejects an unapproved request', () => {
    const request = requestGrantApproval(draft, { requester: { requestedBy: 'agent:requester' } });
    approvalIds.push(request.id);
    expect(request.details).toContain('meeting.recording');
    expect(request.details).toContain('acme');
    expect(request.details).toContain('https://meet.google.com/abc-defg-hij');
    expect(request.details).toContain('weekly sync minutes');
    expect(request.details).toContain('30 day');
    expect(() => grantStanding(draft, { approvalRequestId: request.id })).toThrow(
      /pending, not approved/
    );
    expect(safeExistsSync(GRANTS_ROOT) ? listGrants({ tenant_slug: 'acme' }) : []).toEqual([]);
  });

  it('rejects an approval bound to a different draft (payload hash)', () => {
    const request = requestGrantApproval(draft, { requester: { requestedBy: 'agent:requester' } });
    approvalIds.push(request.id);
    approve(request);
    expect(() =>
      grantStanding({ ...draft, purpose: 'something else' }, { approvalRequestId: request.id })
    ).toThrow(/different capability/);
    expect(() =>
      grantStanding(
        { ...draft, meeting_urls: ['https://meet.google.com/other'] },
        {
          approvalRequestId: request.id,
        }
      )
    ).toThrow(/different capability/);
  });

  it('rejects a non-human decision', () => {
    const request = requestGrantApproval(draft, { requester: { requestedBy: 'agent:requester' } });
    approvalIds.push(request.id);
    // The store refuses an agent decision on a human-only request outright…
    expect(() => approve(request, { decidedByType: 'ai_agent', authenticated: false })).toThrow();
    expect(() => grantStanding(draft, { approvalRequestId: request.id })).toThrow(
      /pending, not approved/
    );
    // …and the apply side re-checks the decider even if a record claims approval.
    approve(request);
    const approved = loadApprovalRequest(GRANT_APPROVAL_CHANNEL, request.id)!;
    writeGovernedArtifactJson(
      'mission_controller',
      approvalRequestLogicalPath(GRANT_APPROVAL_CHANNEL, request.id),
      {
        ...approved,
        workflow: {
          ...approved.workflow!,
          approvals: approved.workflow!.approvals.map((entry) => ({
            ...entry,
            decidedByType: 'ai_agent' as const,
          })),
        },
      }
    );
    expect(() => grantStanding(draft, { approvalRequestId: request.id })).toThrow(
      /authenticated human decision/
    );
  });

  it('rejects an expired approval', () => {
    const request = requestGrantApproval(draft, { requester: { requestedBy: 'agent:requester' } });
    approvalIds.push(request.id);
    approve(request);
    const approved = loadApprovalRequest(GRANT_APPROVAL_CHANNEL, request.id)!;
    writeGovernedArtifactJson(
      'mission_controller',
      approvalRequestLogicalPath(GRANT_APPROVAL_CHANNEL, request.id),
      { ...approved, expiresAt: new Date(Date.now() - 60_000).toISOString() }
    );
    expect(() => grantStanding(draft, { approvalRequestId: request.id })).toThrow(/expired/);
    expect(listGrants({ tenant_slug: 'acme' })).toEqual([]);
  });

  it('consumes the approval once: a second grant under it is rejected', () => {
    const request = requestGrantApproval(draft, { requester: { requestedBy: 'agent:requester' } });
    approvalIds.push(request.id);
    approve(request);
    grantStanding(draft, { approvalRequestId: request.id });
    const consumption = loadApprovalRequest(GRANT_APPROVAL_CHANNEL, request.id)?.consumption;
    expect(consumption?.consumer).toBe('grant_standing');
    const [created] = listGrants({ tenant_slug: 'acme' });
    expect(consumption?.effectRef).toBe(created.grant_id);
    expect(consumption?.consumedAt).toBe(created.granted_at);
    expect(Date.parse(created.expires_at) - Date.parse(created.granted_at)).toBe(30 * 86_400_000);
    expect(() => grantStanding(draft, { approvalRequestId: request.id })).toThrow(/already used/);
    expect(listGrants({ tenant_slug: 'acme' })).toHaveLength(1);
    // A consumed request is not handed back for reuse.
    const next = requestGrantApproval(draft, { requester: { requestedBy: 'agent:requester' } });
    approvalIds.push(next.id);
    expect(next.id).not.toBe(request.id);
  });
});

describe('resolveGrant', () => {
  const meeting = { url: 'https://meet.google.com/abc-defg-hij?pli=1' };

  it('allows a matching standing grant by URL or series id', () => {
    const record = approvedGrant();
    expect(
      resolveGrant({ capability: 'meeting.recording', context: { tenant_slug: 'acme', meeting } })
    ).toEqual({ allowed: true, source: 'standing', grant_id: record.grant_id });
    expect(
      resolveGrant({
        capability: 'meeting.recording',
        context: { tenant_slug: 'acme', meeting: { series_id: 'series-weekly' } },
      }).allowed
    ).toBe(true);
  });

  it('grants nothing when a stored record is widened or its approval basis is forged', () => {
    const record = approvedGrant();
    const file = grantRecordPath('acme', record.grant_id);
    const otherMeeting = { url: 'https://zoom.us/j/999' };

    // Widened outside grantStanding: the approval's payloadHash no longer covers it.
    safeWriteFile(
      file,
      JSON.stringify({
        ...record,
        scope: {
          ...record.scope,
          meeting_urls: [...(record.scope.meeting_urls ?? []), 'https://zoom.us/j/999'],
        },
      })
    );
    const widened = resolveGrant({
      capability: 'meeting.recording',
      context: { tenant_slug: 'acme', meeting: otherMeeting },
    });
    expect(widened.allowed).toBe(false);
    expect(widened.reason).toMatch(/valid human approval/);

    // A basis naming an approval that does not exist grants nothing.
    safeWriteFile(
      file,
      JSON.stringify({ ...record, basis: { ...record.basis, approval_request_id: 'forged-id' } })
    );
    expect(
      resolveGrant({ capability: 'meeting.recording', context: { tenant_slug: 'acme', meeting } })
        .allowed
    ).toBe(false);
  });

  it('grants nothing after tampering with revocation, identity or validity window', () => {
    const resolve = () =>
      resolveGrant({ capability: 'meeting.recording', context: { tenant_slug: 'acme', meeting } });
    const record = approvedGrant();
    const file = grantRecordPath('acme', record.grant_id);
    expect(resolve().allowed).toBe(true);

    // Copy under a new id: the approval's consumption names the original id,
    // and two records naming one approval grant nothing at all.
    const copyId = 'GRT-20261019-cccccccccccc';
    safeWriteFile(grantRecordPath('acme', copyId), JSON.stringify({ ...record, grant_id: copyId }));
    expect(resolve().allowed).toBe(false);
    // …and the copy alone (original removed) is not the record the approval made.
    safeRmSync(file, { force: true });
    expect(resolve().allowed).toBe(false);
    safeRmSync(grantRecordPath('acme', copyId), { force: true });
    safeWriteFile(file, JSON.stringify(record));
    expect(resolve().allowed).toBe(true);

    // Shifting granted_at and expires_at forward together (renewal) breaks the
    // binding to the consumption time.
    const shift = (iso: string) => new Date(Date.parse(iso) + 30 * 86_400_000).toISOString();
    safeWriteFile(
      file,
      JSON.stringify({
        ...record,
        granted_at: shift(record.granted_at),
        expires_at: shift(record.expires_at),
      })
    );
    expect(resolve().allowed).toBe(false);

    // ttl drift: a few hours longer than the approved whole days.
    safeWriteFile(
      file,
      JSON.stringify({
        ...record,
        expires_at: new Date(Date.parse(record.expires_at) + 6 * 3_600_000).toISOString(),
      })
    );
    expect(resolve().allowed).toBe(false);
    safeWriteFile(file, JSON.stringify(record));
    expect(resolve().allowed).toBe(true);

    // Un-revoke: revocation also withdraws the approval (outside the tenant
    // partition), so deleting `revoked` from the record does not bring it back.
    const revoked = revokeGrant(record.grant_id, { by: HUMAN_ACTOR, reason: 'stop' });
    expect(revoked.revoked?.by_kind).toBe('human');
    expect(
      loadApprovalRequest(GRANT_APPROVAL_CHANNEL, record.basis!.approval_request_id)?.revocation
    ).toMatchObject({ revokedBy: HUMAN });
    const { revoked: _revoked, ...unrevoked } = revoked;
    safeWriteFile(file, JSON.stringify(unrevoked));
    const after = resolve();
    expect(after.allowed).toBe(false);
    expect(after.reason).toMatch(/valid human approval/);
  });

  it('attributes an agent revocation to the agent', () => {
    const record = approvedGrant();
    const auditSpy = vi.spyOn(auditChain, 'record');
    const revoked = revokeGrant(record.grant_id, {
      by: { kind: 'agent', id: 'agent:claude-code' },
      reason: 'meeting cancelled',
    });
    expect(revoked.revoked).toMatchObject({ by: 'agent:claude-code', by_kind: 'agent' });
    const revokeAudit = auditSpy.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.action === 'grant.revoked');
    expect(revokeAudit?.agentId).toBe('agent:claude-code');
    expect(revokeAudit?.metadata?.actor_kind).toBe('agent');
    expect(revokeAudit?.actor?.kind).not.toBe('human');
    auditSpy.mockRestore();
    expect(
      loadApprovalRequest(GRANT_APPROVAL_CHANNEL, record.basis!.approval_request_id)?.revocation
        ?.revokedBy
    ).toBe('agent:claude-code');
    expect(() =>
      revokeGrant(record.grant_id, { by: { kind: 'human', id: ' ' }, reason: 'x' })
    ).toThrow(/already revoked|human or agent actor/);
  });

  it('isolates tenants and meetings', () => {
    approvedGrant();
    const otherTenant = resolveGrant({
      capability: 'meeting.recording',
      context: { tenant_slug: 'globex', meeting },
    });
    expect(otherTenant.allowed).toBe(false);
    expect(otherTenant.remedy).toContain('pnpm kyberion grants grant');
    expect(
      resolveGrant({
        capability: 'meeting.recording',
        context: { tenant_slug: 'acme', meeting: { url: 'https://meet.google.com/zzz-zzzz-zzz' } },
      }).allowed
    ).toBe(false);
    expect(
      resolveGrant({ capability: 'meeting.recording', context: { tenant_slug: 'acme' } }).reason
    ).toMatch(/no meeting URL or series id/);
    expect(resolveGrant({ capability: 'meeting.recording', context: { meeting } }).reason).toMatch(
      /no tenant/
    );
  });

  it('fails closed on expired and revoked grants and unknown capabilities', () => {
    // The grant starts when its approval is consumed, so age the whole flow.
    vi.useFakeTimers({ now: new Date(Date.now() - 40 * 86_400_000), toFake: ['Date'] });
    try {
      approvedGrant(draft);
    } finally {
      vi.useRealTimers();
    }
    const expired = resolveGrant({
      capability: 'meeting.recording',
      context: { tenant_slug: 'acme', meeting },
    });
    expect(expired).toMatchObject({ allowed: false });
    expect(expired.reason).toMatch(/expired/);

    safeRmSync(GRANTS_ROOT, { recursive: true, force: true });
    const record = approvedGrant();
    revokeGrant(record.grant_id, { by: HUMAN_ACTOR, reason: 'stop' });
    expect(
      resolveGrant({ capability: 'meeting.recording', context: { tenant_slug: 'acme', meeting } })
        .reason
    ).toMatch(/revoked/);
    expect(resolveGrant({ capability: 'nope.unknown', context: {} })).toMatchObject({
      allowed: false,
    });
  });

  it('maps OS probe states', () => {
    const probe = (microphone: string) => () =>
      ({
        available: true,
        automation: 'granted',
        browser_automation: 'granted',
        accessibility: 'granted',
        screen_recording: 'denied',
        microphone,
        host_app: 'com.apple.Terminal',
      }) as never;
    expect(
      resolveGrant({ capability: 'os.microphone', context: {} }, { probe: probe('granted') })
    ).toEqual({ allowed: true, source: 'os' });
    const undetermined = resolveGrant(
      { capability: 'os.microphone', context: {} },
      { probe: probe('not_determined') }
    );
    expect(undetermined.allowed).toBe(false);
    expect(undetermined.remedy).toBe('pnpm kyberion permissions warmup --only microphone');
    const denied = resolveGrant(
      { capability: 'os.screen_recording', context: {} },
      { probe: probe('granted') }
    );
    expect(denied.allowed).toBe(false);
    expect(denied.remedy).toMatch(/System Settings/);
  });

  it('meeting.voice uses only the mission voice consent, never a standing grant', () => {
    approvedGrant();
    writeMission();
    const result = resolveGrant({
      capability: 'meeting.voice',
      context: { tenant_slug: 'acme', mission_id: MISSION_ID, meeting },
    });
    expect(result.allowed).toBe(false);
    expect(result.source).toBe('mission');
    expect(result.reason).toMatch(/voice-consent\.json missing/);
    safeWriteFile(
      path.join(MISSION_DIR, 'evidence/voice-consent.json'),
      JSON.stringify({ consent: 'granted', mission_id: MISSION_ID, operator_handle: 'op' })
    );
    expect(
      resolveGrant({ capability: 'meeting.voice', context: { mission_id: MISSION_ID } })
    ).toEqual({ allowed: true, source: 'mission' });
    // A mission voice consent is the legacy source of meeting.recording.
    expect(
      resolveGrant({ capability: 'meeting.recording', context: { mission_id: MISSION_ID } })
    ).toEqual({ allowed: true, source: 'legacy' });
  });
});

describe('recordGrantMissionBinding', () => {
  it('records a binding once per grant in the mission evidence', () => {
    writeMission();
    const first = recordGrantMissionBinding(MISSION_ID, {
      capability: 'meeting.recording',
      grant_id: 'GRT-20261019-aaaaaaaaaaaa',
    });
    expect(first.recorded).toBe(true);
    const again = recordGrantMissionBinding(MISSION_ID, {
      capability: 'meeting.recording',
      grant_id: 'GRT-20261019-aaaaaaaaaaaa',
    });
    expect(again.recorded).toBe(false);
    recordGrantMissionBinding(MISSION_ID, {
      capability: 'meeting.recording',
      grant_id: 'GRT-20261019-bbbbbbbbbbbb',
    });
    expect(readGrantMissionBindings(MISSION_ID).map((b) => b.grant_id)).toEqual([
      'GRT-20261019-aaaaaaaaaaaa',
      'GRT-20261019-bbbbbbbbbbbb',
    ]);
  });

  it('fails closed for an unknown mission', () => {
    expect(() =>
      recordGrantMissionBinding('MSN-GRANT-DOES-NOT-EXIST', {
        capability: 'meeting.recording',
        grant_id: 'GRT-20261019-aaaaaaaaaaaa',
      })
    ).toThrow();
  });
});

describe('revokeStandingEffectApproval', () => {
  it('refuses an empty consumer or effectRef', () => {
    for (const bad of [
      { consumer: 'grant_standing', effectRef: '' },
      { consumer: '', effectRef: 'GRT-x' },
      { consumer: 'grant_standing', effectRef: undefined as unknown as string },
    ]) {
      expect(() =>
        revokeStandingEffectApproval('mission_controller', {
          channel: 'grant-standing',
          requestId: 'any',
          revokedBy: 'agent:x',
          reason: 'test',
          ...bad,
        })
      ).toThrow(/consumer and an effectRef/);
    }
  });
});
