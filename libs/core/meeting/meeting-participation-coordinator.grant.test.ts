import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '../storage-layout.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
} from '../governance/approval-store.js';
import {
  GRANT_APPROVAL_CHANNEL,
  grantStanding,
  requestGrantApproval,
  type GrantDraft,
  type GrantRecord,
} from '../governance/grant-store.js';
import { readGrantMissionBindings } from '../governance/grant-resolver.js';
import { evaluateGrantReadiness } from '../governance/grant-readiness.js';
import { StubAudioBus } from '../voice/audio-bus.js';
import { StubStreamingSpeechToTextBridge } from '../voice/streaming-stt-bridge.js';
import { StubStreamingTextToSpeechBridge } from '../voice/streaming-tts-bridge.js';
import { EnergyVad } from '../voice/voice-activity-detector.js';
import { StubMeetingJoinDriver } from './meeting-join-driver.js';
import {
  MeetingParticipationCoordinator,
  checkMeetingParticipationConsent,
} from './meeting-participation-coordinator.js';

const GRANTS_ROOT = pathResolver.rootResolve(PARTITIONED_RUNTIME_STATE_ROOTS.grants);
const MISSION_ID = 'MSN-MTG-GRANT-TEST';
const MISSION_DIR = path.join(pathResolver.rootDir(), 'active/missions/confidential', MISSION_ID);
const MEETING_URL = 'https://meet.google.com/grant-test-abc';
const approvalIds: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

const draft: GrantDraft = {
  capability: 'meeting.recording',
  tenant_slug: 'acme',
  meeting_urls: [MEETING_URL],
  purpose: 'weekly minutes',
  ttl_days: 30,
};

function standingGrant(grantDraft: GrantDraft = draft): GrantRecord {
  const request = requestGrantApproval(grantDraft, {
    requester: { requestedBy: 'agent:requester' },
  });
  approvalIds.push(request.id);
  decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision: 'approved',
    decidedBy: 'user:grant-owner',
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
  });
  return grantStanding(grantDraft, { approvalRequestId: request.id });
}

const SERIES_ID = 'series-weekly-sync';
const seriesDraft: GrantDraft = {
  capability: 'meeting.recording',
  tenant_slug: 'acme',
  meeting_series_ids: [SERIES_ID],
  purpose: 'weekly minutes by series',
  ttl_days: 30,
};

function writeMission(tenant: string | null = 'acme'): void {
  safeMkdir(path.join(MISSION_DIR, 'evidence'), { recursive: true });
  safeWriteFile(
    path.join(MISSION_DIR, 'mission-state.json'),
    JSON.stringify({
      mission_id: MISSION_ID,
      tier: 'confidential',
      assigned_persona: 'ecosystem_architect',
      ...(tenant ? { tenant_slug: tenant } : {}),
    })
  );
}

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
  vi.restoreAllMocks();
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

describe('checkMeetingParticipationConsent standing-grant fallback (PG-04)', () => {
  it('without a grant keeps the voice-consent reason and adds the grant remedy', () => {
    writeMission();
    const result = checkMeetingParticipationConsent({
      mission_id: MISSION_ID,
      tenant_slug: 'acme',
      purpose: 'recording',
      meeting: { url: MEETING_URL },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/voice-consent\.json missing/);
    expect(result.reason).toContain('pnpm kyberion grants grant --capability meeting.recording');
  });

  it('allows recording under a matching standing grant and binds it to the mission once', () => {
    writeMission();
    const grant = standingGrant();
    const input = {
      mission_id: MISSION_ID,
      tenant_slug: 'acme',
      purpose: 'recording' as const,
      meeting: { url: `${MEETING_URL}/?authuser=0` },
    };
    expect(checkMeetingParticipationConsent(input)).toEqual({
      allowed: true,
      grant_id: grant.grant_id,
    });
    expect(checkMeetingParticipationConsent(input).allowed).toBe(true);
    expect(readGrantMissionBindings(MISSION_ID)).toEqual([
      expect.objectContaining({ capability: 'meeting.recording', grant_id: grant.grant_id }),
    ]);
  });

  it('allows recording without a mission when a grant covers the meeting', () => {
    const grant = standingGrant();
    expect(
      checkMeetingParticipationConsent({
        tenant_slug: 'acme',
        purpose: 'recording',
        meeting: { url: MEETING_URL },
      })
    ).toEqual({ allowed: true, grant_id: grant.grant_id });
  });

  it('never lets a standing grant allow speaking', () => {
    writeMission();
    standingGrant();
    const result = checkMeetingParticipationConsent({
      mission_id: MISSION_ID,
      tenant_slug: 'acme',
      purpose: 'voice',
      meeting: { url: MEETING_URL },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/voice-consent\.json missing/);
    expect(readGrantMissionBindings(MISSION_ID)).toEqual([]);
  });

  it('does not fall back for another tenant or a rejected mission path', () => {
    standingGrant();
    expect(
      checkMeetingParticipationConsent({
        tenant_slug: 'globex',
        purpose: 'recording',
        meeting: { url: MEETING_URL },
      }).allowed
    ).toBe(false);
    const traversal = checkMeetingParticipationConsent({
      mission_id: '../outside',
      tenant_slug: 'acme',
      purpose: 'recording',
      meeting: { url: MEETING_URL },
    });
    expect(traversal.allowed).toBe(false);
    expect(traversal.reason).toMatch(/mission evidence path rejected/);
  });

  it('inside a mission uses the mission tenant and denies a disagreeing caller tenant', () => {
    standingGrant();
    // Mission of another tenant: the acme grant does not apply even when the
    // caller claims acme.
    writeMission('globex');
    const mismatch = checkMeetingParticipationConsent({
      mission_id: MISSION_ID,
      tenant_slug: 'acme',
      purpose: 'recording',
      meeting: { url: MEETING_URL },
    });
    expect(mismatch.allowed).toBe(false);
    expect(mismatch.reason).toMatch(/belongs to tenant globex, not the caller tenant acme/);
    // Same mission without a caller tenant: resolved as globex, no grant there.
    expect(
      checkMeetingParticipationConsent({
        mission_id: MISSION_ID,
        purpose: 'recording',
        meeting: { url: MEETING_URL },
      }).allowed
    ).toBe(false);
    // A mission bound to no tenant cannot use a tenant-bound grant.
    writeMission(null);
    const untenanted = checkMeetingParticipationConsent({
      mission_id: MISSION_ID,
      tenant_slug: 'acme',
      purpose: 'recording',
      meeting: { url: MEETING_URL },
    });
    expect(untenanted.allowed).toBe(false);
    expect(untenanted.reason).toMatch(/not bound to a tenant/);
    // The acme mission with no caller tenant derives acme from the mission.
    writeMission('acme');
    expect(
      checkMeetingParticipationConsent({
        mission_id: MISSION_ID,
        purpose: 'recording',
        meeting: { url: MEETING_URL },
      }).allowed
    ).toBe(true);
  });

  it('the coordinator passes the target URL, so a granted meeting is joined', async () => {
    writeMission();
    const grant = standingGrant();
    const bus = new StubAudioBus();
    const openSpy = vi.spyOn(bus, 'open');
    bus.injectInbound({
      format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
      payload: new Uint8Array(320),
      ts_ms: 0,
    });
    await new MeetingParticipationCoordinator({
      driver: new StubMeetingJoinDriver(),
      bus,
      stt: new StubStreamingSpeechToTextBridge(1),
      tts: new StubStreamingTextToSpeechBridge(),
      vad: new EnergyVad(),
      agent: {
        async onUtterance() {
          return { leave: true };
        },
      },
    }).run(
      { url: MEETING_URL, platform: 'meet' },
      {
        mission_id: MISSION_ID,
        tenant_slug: 'acme',
        require_voice_consent: false,
        max_minutes: 1,
        voice_profile_id: 'operator-default-v1',
        audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
      }
    );
    expect(openSpy).toHaveBeenCalled();
    expect(readGrantMissionBindings(MISSION_ID).map((b) => b.grant_id)).toEqual([grant.grant_id]);
  });

  it('a series-bound grant allows the meeting the calendar target names by series id (PG-07)', async () => {
    writeMission();
    const grant = standingGrant(seriesDraft);
    const bus = new StubAudioBus();
    const openSpy = vi.spyOn(bus, 'open');
    bus.injectInbound({
      format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
      payload: new Uint8Array(320),
      ts_ms: 0,
    });
    await new MeetingParticipationCoordinator({
      driver: new StubMeetingJoinDriver(),
      bus,
      stt: new StubStreamingSpeechToTextBridge(1),
      tts: new StubStreamingTextToSpeechBridge(),
      vad: new EnergyVad(),
      agent: {
        async onUtterance() {
          return { leave: true };
        },
      },
    }).run(
      // A fresh meeting URL each week: only the series id matches the grant.
      { url: 'https://meet.google.com/this-week-xyz', platform: 'meet', series_id: SERIES_ID },
      {
        mission_id: MISSION_ID,
        tenant_slug: 'acme',
        require_voice_consent: false,
        max_minutes: 1,
        voice_profile_id: 'operator-default-v1',
        audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
      }
    );
    expect(openSpy).toHaveBeenCalled();
    expect(readGrantMissionBindings(MISSION_ID).map((b) => b.grant_id)).toEqual([grant.grant_id]);
  });

  it('record_binding false answers without writing the mission binding', () => {
    writeMission();
    const grant = standingGrant(seriesDraft);
    expect(
      checkMeetingParticipationConsent({
        mission_id: MISSION_ID,
        purpose: 'recording',
        meeting: { series_id: SERIES_ID },
        record_binding: false,
      })
    ).toEqual({ allowed: true, grant_id: grant.grant_id });
    expect(readGrantMissionBindings(MISSION_ID)).toEqual([]);
  });

  it('a denial carries the standing-grant request command as remedy', () => {
    const result = checkMeetingParticipationConsent({
      tenant_slug: 'acme',
      purpose: 'recording',
      meeting: { series_id: SERIES_ID },
    });
    expect(result.allowed).toBe(false);
    expect(result.remedy).toBe(
      'pnpm kyberion grants grant --capability meeting.recording --tenant acme --meeting-series series-weekly-sync --purpose "<purpose>" --request-approval'
    );
  });
});

describe('evaluateGrantReadiness against the real stores (PG-06)', () => {
  it('reports a missing recording grant with its remedy, then ready once granted', () => {
    writeMission();
    const context = { mission_id: MISSION_ID, meeting: { series_id: SERIES_ID } };
    const before = evaluateGrantReadiness({ profile: 'meeting.online', context });
    expect(before.ready).toBe(false);
    expect(before.missing).toEqual(['meeting.recording']);
    const recording = before.items.find((item) => item.capability === 'meeting.recording');
    expect(recording?.remedy).toContain('--meeting-series series-weekly-sync');
    // meeting.voice is optional: missing, but not blocking.
    expect(before.items.find((item) => item.capability === 'meeting.voice')).toMatchObject({
      required: false,
      allowed: false,
      remedy: `pnpm meeting:consent grant --mission ${MISSION_ID}`,
    });

    const grant = standingGrant(seriesDraft);
    const after = evaluateGrantReadiness({ profile: 'meeting.online', context });
    expect(after.ready).toBe(true);
    expect(after.items.find((item) => item.capability === 'meeting.recording')).toMatchObject({
      allowed: true,
      source: 'standing',
      grant_id: grant.grant_id,
    });
    // Asking is not using: no binding recorded.
    expect(readGrantMissionBindings(MISSION_ID)).toEqual([]);
  });
});
