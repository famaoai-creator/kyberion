import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissionEvidenceDoc } from './mission-evidence-doc.js';
import * as pathResolver from './path-resolver.js';

const FIX_MISSION = 'MSN-EVIDENCE-DOC-FIX-001';
const ROOT = pathResolver.rootDir();
const MISSION_DIR = path.join(ROOT, 'active/missions/confidential', FIX_MISSION);

interface SampleDoc {
  kind: 'sample';
  value: string;
}

function isSampleDoc(d: unknown): d is SampleDoc {
  return Boolean(d && typeof d === 'object' && (d as any).kind === 'sample' && typeof (d as any).value === 'string');
}

describe('MissionEvidenceDoc', () => {
  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.MISSION_ID = FIX_MISSION;
    fs.mkdirSync(path.join(MISSION_DIR, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(MISSION_DIR, 'mission-state.json'),
      JSON.stringify({
        mission_id: FIX_MISSION,
        tier: 'confidential',
        assigned_persona: 'ecosystem_architect',
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(MISSION_DIR, { recursive: true, force: true });
  });

  it('round-trips a typed record', () => {
    const doc = new MissionEvidenceDoc<SampleDoc>({
      mission_id: FIX_MISSION,
      filename: 'sample.json',
      validate: isSampleDoc,
    });
    expect(doc.exists()).toBe(false);
    doc.write({ kind: 'sample', value: 'hello' });
    expect(doc.exists()).toBe(true);
    expect(doc.read()).toEqual({ kind: 'sample', value: 'hello' });
  });

  it('returns null for an absent doc', () => {
    const doc = new MissionEvidenceDoc<SampleDoc>({
      mission_id: FIX_MISSION,
      filename: 'absent.json',
      validate: isSampleDoc,
    });
    expect(doc.read()).toBeNull();
  });

  it('returns null when the validator rejects the doc', () => {
    const doc = new MissionEvidenceDoc<SampleDoc>({
      mission_id: FIX_MISSION,
      filename: 'bad.json',
      validate: isSampleDoc,
    });
    fs.writeFileSync(
      path.join(MISSION_DIR, 'evidence', 'bad.json'),
      JSON.stringify({ kind: 'wrong-shape' }),
    );
    expect(doc.read()).toBeNull();
  });

  it('emits an audit event id when audit options are supplied', () => {
    const doc = new MissionEvidenceDoc<SampleDoc>({
      mission_id: FIX_MISSION,
      filename: 'audit.json',
      agent_id: 'evidence-doc-test',
      validate: isSampleDoc,
    });
    const { audit_event_id } = doc.write(
      { kind: 'sample', value: 'with-audit' },
      { action: 'sample.event', reason: 'because tests', metadata: { foo: 'bar' } },
    );
    expect(audit_event_id).toMatch(/^/);
    expect(doc.read()).toEqual({ kind: 'sample', value: 'with-audit' });
  });

  it('write without audit returns an empty audit_event_id', () => {
    const doc = new MissionEvidenceDoc<SampleDoc>({
      mission_id: FIX_MISSION,
      filename: 'no-audit.json',
    });
    const out = doc.write({ kind: 'sample', value: 'silent' });
    expect(out.audit_event_id).toBe('');
  });
});
