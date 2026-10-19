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

function standingGrant(): GrantRecord {
  const request = requestGrantApproval(draft, { requester: { requestedBy: 'agent:requester' } });
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
  return grantStanding(draft, { approvalRequestId: request.id });
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
});
