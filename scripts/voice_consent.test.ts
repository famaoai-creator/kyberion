import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core';
import { grantVoiceConsent, revokeVoiceConsent } from './voice_consent.js';

const ROOT = pathResolver.rootDir();
const FIX_MISSION = 'MSN-VOICE-CONSENT-FIXTURE-001';
const MISSION_DIR = path.join(ROOT, 'active/missions/confidential', FIX_MISSION);

describe('voice_consent CLI helpers', () => {
  let savedMission: string | undefined;
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let savedTenant: string | undefined;

  beforeEach(() => {
    savedMission = process.env.MISSION_ID;
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    savedTenant = process.env.KYBERION_TENANT;
    process.env.MISSION_ID = FIX_MISSION;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_TENANT = 'alpha-team';
    fs.mkdirSync(path.join(MISSION_DIR, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(MISSION_DIR, 'mission-state.json'),
      JSON.stringify({
        mission_id: FIX_MISSION,
        tier: 'confidential',
        assigned_persona: 'ecosystem_architect',
        tenant_slug: 'alpha-team',
      }),
    );
  });

  afterEach(() => {
    if (savedMission === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = savedMission;
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    fs.rmSync(MISSION_DIR, { recursive: true, force: true });
  });

  it('grants consent, records an audit event, and revokes idempotently', () => {
    const auditPath = path.join(
      ROOT,
      'active/audit',
      `audit-${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    const before = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';

    grantVoiceConsent(FIX_MISSION, 'operator', 'meeting speak', 'test grant');

    const granted = JSON.parse(
      fs.readFileSync(path.join(MISSION_DIR, 'evidence/voice-consent.json'), 'utf8'),
    );
    expect(granted.consent).toBe('granted');
    expect(granted.tenant_slug).toBe('alpha-team');
    expect(granted.audit_event_id).toBeTruthy();

    revokeVoiceConsent(FIX_MISSION, 'test revoke');
    const revoked = JSON.parse(
      fs.readFileSync(path.join(MISSION_DIR, 'evidence/voice-consent.json'), 'utf8'),
    );
    expect(revoked.consent).toBe('revoked');
    expect(revoked.audit_event_id).toBeTruthy();

    revokeVoiceConsent(FIX_MISSION, 'test revoke');
    const after = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toContain('voice_consent.grant');
    expect(after).toContain('voice_consent.revoke');
  });

  it('rejects invalid expiration timestamps before writing consent', () => {
    expect(() => {
      grantVoiceConsent(FIX_MISSION, 'operator', 'meeting speak', 'test grant', false, 'not-a-date');
    }).toThrow(/expires_at/);
    expect(fs.existsSync(path.join(MISSION_DIR, 'evidence/voice-consent.json'))).toBe(false);
  });
});
