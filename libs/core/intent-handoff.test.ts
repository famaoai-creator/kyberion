import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpBase: string;

vi.mock('./path-resolver.js', () => ({
  sharedTmp: (sub = '') => path.join(tmpBase, sub),
}));

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeExistsSync: (p: string) => actual.existsSync(p),
    safeReadFile: (p: string, opts: { encoding?: string }) =>
      actual.readFileSync(p, opts as { encoding: BufferEncoding }),
    safeUnlinkSync: (p: string) => actual.unlinkSync(p),
    safeWriteFile: (p: string, data: string) => {
      actual.mkdirSync(path.dirname(p), { recursive: true });
      actual.writeFileSync(p, data);
    },
  };
});

import { writeIntentGoalHandoff, consumeIntentGoalHandoff } from './intent-handoff.js';

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
});
