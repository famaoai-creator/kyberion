import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compileSchemaFromPath,
  pathResolver,
  safeReadFile,
  safeReaddir,
} from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('meeting-actuator', () => {
  const SCHEMA_PATH = path.join(
    pathResolver.rootDir(),
    'schemas/meeting-action.schema.json',
  );

  it('emits a join action that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, SCHEMA_PATH);
    const action = {
      action: 'join',
      params: {
        platform: 'zoom',
        url: 'https://example.zoom.us/j/9999999999',
        meeting_id: '9999999999',
      },
    };
    const valid = validate(action);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('emits a leave action that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, SCHEMA_PATH);
    const action = { action: 'leave', params: { platform: 'auto' } };
    expect(validate(action), JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('emits a listen action that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, SCHEMA_PATH);
    const action = {
      action: 'listen',
      params: { platform: 'auto', duration_sec: 30 },
    };
    expect(validate(action), JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('every example file in examples/ validates against the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, SCHEMA_PATH);
    const examplesDir = path.join(
      pathResolver.rootDir(),
      'libs/actuators/meeting-actuator/examples',
    );
    const failures: string[] = [];
    for (const entry of safeReaddir(examplesDir)) {
      if (!entry.endsWith('.json')) continue;
      const text = safeReadFile(path.join(examplesDir, entry), { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(text);
      if (!validate(parsed)) {
        failures.push(`${entry}: ${JSON.stringify(validate.errors)}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('rejects an action with an unknown action verb', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, SCHEMA_PATH);
    const bad = { action: 'levitate', params: { platform: 'zoom' } };
    expect(validate(bad)).toBe(false);
  });

  it('rejects an action with an unknown platform', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, SCHEMA_PATH);
    const bad = { action: 'join', params: { platform: 'discord', url: 'https://x' } };
    expect(validate(bad)).toBe(false);
  });
});

describe('meeting-actuator voice-consent gate', () => {
  const FIX_MISSION = 'MSN-MEETING-CONSENT-FIXTURE-001';
  const fs = require('node:fs');
  const path2 = require('node:path');
  const ROOT = pathResolver.rootDir();
  const MISSION_DIR = path2.join(ROOT, 'active/missions/confidential', FIX_MISSION);
  let savedMission: string | undefined;
  let savedSudo: string | undefined;
  let savedPersona: string | undefined;

  beforeEach(() => {
    savedMission = process.env.MISSION_ID;
    savedSudo = process.env.KYBERION_SUDO;
    savedPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ID = FIX_MISSION;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    delete process.env.KYBERION_SUDO;
    fs.mkdirSync(path2.join(MISSION_DIR, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path2.join(MISSION_DIR, 'mission-state.json'),
      JSON.stringify({
        mission_id: FIX_MISSION,
        tier: 'confidential',
        assigned_persona: 'ecosystem_architect',
      }),
    );
  });

  afterEach(() => {
    if (savedMission === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = savedMission;
    if (savedSudo === undefined) delete process.env.KYBERION_SUDO;
    else process.env.KYBERION_SUDO = savedSudo;
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    try {
      fs.rmSync(MISSION_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('denies speak() when voice-consent.json is missing', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'speak',
      params: { platform: 'auto', text: 'hello' },
    });
    expect(result.status).toBe('denied');
    expect(result.message).toMatch(/voice-consent.json missing/);
  });

  it('denies speak() when consent != "granted"', async () => {
    fs.writeFileSync(
      path2.join(MISSION_DIR, 'evidence/voice-consent.json'),
      JSON.stringify({ consent: 'pending' }),
    );
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'speak',
      params: { platform: 'auto', text: 'hello' },
    });
    expect(result.status).toBe('denied');
    expect(result.message).toMatch(/consent != 'granted'/);
  });

  it('does not gate non-speak verbs', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({ action: 'status', params: { platform: 'auto' } });
    // Either bridge succeeds or fails on platform issue, but not via consent denial.
    expect(result.status).not.toBe('denied');
  });
});

