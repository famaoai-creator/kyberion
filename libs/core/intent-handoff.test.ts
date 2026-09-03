import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpBase: string;

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return {
    ...actual,
    sharedTmp: (sub = '') => path.join(tmpBase, sub),
  };
});

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeExistsSync: (p: string) => actual.existsSync(p),
    safeLstat: (p: string) => actual.lstatSync(p),
    assertSafeRepositoryPath: (p: string) => p,
    safeReadFile: (p: string, opts: { encoding?: string }) =>
      actual.readFileSync(p, opts as { encoding: BufferEncoding }),
    safeUnlinkSync: (p: string) => actual.unlinkSync(p),
    safeWriteFile: (p: string, data: string) => {
      actual.mkdirSync(path.dirname(p), { recursive: true });
      actual.writeFileSync(p, data);
    },
  };
});

vi.mock('./foundation/json.js', () => ({
  readJson: <T>(filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
}));

import { registerFoundationIo } from './foundation/io.js';

registerFoundationIo({
  loadJson: <T>(filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
  loadJsonIfPresent: <T>(filePath: string) => {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  },
  appendFile: (filePath, content) => fs.appendFileSync(filePath, content, 'utf8'),
  exists: (filePath) => fs.existsSync(filePath),
  readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  stat: (filePath) => fs.statSync(filePath),
  writeFile: (filePath, content) => fs.writeFileSync(filePath, content, 'utf8'),
});

import {
  writeIntentGoalHandoff,
  consumeIntentGoalHandoff,
  loadIntentGoalHandoffAtPath,
} from './intent-handoff.js';

describe('intent-handoff', () => {
  it('round-trips the payload and deletes the file on consume', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-intent-handoff-'));
    const payload = {
      source_text: '来週の提案資料を作って',
      correlation_id: 'corr-handoff-001',
      origin_intent_id: 'bootstrap-project',
      origin_utterance_ref: 'surface://corr-handoff-001',
      goal: { summary: '提案資料の作成', success_condition: 'PPTXが成果物として存在する' },
      outcome_ids: ['OUT-1'],
    };

    const handoffPath = writeIntentGoalHandoff('MSN-TEST', payload);
    expect(fs.existsSync(handoffPath)).toBe(true);

    const consumed = consumeIntentGoalHandoff(handoffPath);
    expect(consumed).toEqual(payload);
    expect(fs.existsSync(handoffPath)).toBe(false);
  });

  it('returns null for a missing file without throwing', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-intent-handoff-'));
    expect(consumeIntentGoalHandoff(path.join(tmpBase, 'nope.json'))).toBeNull();
  });

  it('returns null for malformed JSON without throwing', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-intent-handoff-'));
    const bad = path.join(tmpBase, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    expect(consumeIntentGoalHandoff(bad)).toBeNull();
  });

  it('rejects malformed fields before the handoff reaches mission creation', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-intent-handoff-'));
    const bad = path.join(tmpBase, 'bad-fields.json');
    fs.writeFileSync(
      bad,
      JSON.stringify({ source_text: { unexpected: true }, outcome_ids: ['OUT-1'] })
    );
    expect(consumeIntentGoalHandoff(bad)).toBeNull();
    expect(() => writeIntentGoalHandoff('MSN-TEST', { source_text: 42 } as never)).toThrow(
      'Invalid intent goal handoff payload'
    );
  });

  it('rejects unknown and dangerous nested handoff fields', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-intent-handoff-'));
    const bad = path.join(tmpBase, 'bad-unknown-fields.json');
    fs.writeFileSync(bad, '{"source_text":"ok","goal":{"summary":"ok","__proto__":{}}}');
    expect(consumeIntentGoalHandoff(bad)).toBeNull();
  });

  it('rejects mission identifiers that could escape the handoff directory', () => {
    expect(() =>
      writeIntentGoalHandoff('../escape', { source_text: 'should not be written' })
    ).toThrow(/missionId must be a single safe path segment/u);
  });

  it('rejects a directory at the handoff path before attempting JSON validation', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-intent-handoff-'));
    const directoryPath = path.join(tmpBase, 'directory.json');
    fs.mkdirSync(directoryPath);

    expect(() => loadIntentGoalHandoffAtPath(directoryPath)).toThrow(
      'handoff must be a regular file'
    );
  });

  it('rejects schema-invalid persisted handoff fields', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-intent-handoff-'));
    const bad = path.join(tmpBase, 'bad-schema.json');
    fs.writeFileSync(bad, JSON.stringify({ source_text: 'ok', unexpected: true }));

    expect(() => loadIntentGoalHandoffAtPath(bad)).toThrow(/Invalid catalog intent-goal-handoff/u);
    expect(consumeIntentGoalHandoff(bad)).toBeNull();
    expect(fs.existsSync(bad)).toBe(false);
  });
});
