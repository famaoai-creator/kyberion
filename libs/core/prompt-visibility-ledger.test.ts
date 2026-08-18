import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  appendPromptVisibilityRecord,
  loadPromptVisibilityLedger,
} from './prompt-visibility-ledger.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

describe('prompt visibility ledger', () => {
  const root = pathResolver.sharedTmp(`prompt-visibility-ledger-test/${process.pid}`);

  it('records metadata and never persists raw prompt content', () => {
    safeRmSync(root, { recursive: true, force: true });
    const prompt = 'private prompt text that must not be written';
    const record = appendPromptVisibilityRecord({
      missionPath: root,
      missionId: 'MSN-PVR-TEST',
      source: 'test',
      form: 'system_prompt',
      content: prompt,
      contextPackId: 'CPK-PVR-TEST',
      knowledgeRefs: ['knowledge/a.md', 'knowledge/a.md'],
      now: '2026-08-17T00:00:00.000Z',
    });

    const ledgerPath = path.join(root, 'coordination', 'prompt-visibility.jsonl');
    const raw = String(safeReadFile(ledgerPath, { encoding: 'utf8' }) || '');
    expect(raw).not.toContain(prompt);
    expect(record.knowledge_refs).toEqual(['knowledge/a.md']);
    expect(loadPromptVisibilityLedger(ledgerPath)).toEqual([record]);
  });

  it('rejects malformed records with a stable corruption code', () => {
    safeRmSync(root, { recursive: true, force: true });
    const ledgerPath = path.join(root, 'coordination', 'prompt-visibility.jsonl');
    safeMkdir(path.dirname(ledgerPath), { recursive: true });
    safeWriteFile(ledgerPath, '{"version":1,"mission_id":"broken"}\n', { encoding: 'utf8' });
    expect(() => loadPromptVisibilityLedger(ledgerPath)).toThrow(
      'MISSION_LOG_CORRUPT:prompt_visibility_record'
    );
  });

  it('rejects a record that attempts to persist raw prompt fields', () => {
    safeRmSync(root, { recursive: true, force: true });
    const record = appendPromptVisibilityRecord({
      missionPath: root,
      missionId: 'MSN-PVR-RAW',
      source: 'test',
      form: 'pack',
      content: 'secret',
    });
    const ledgerPath = path.join(root, 'coordination', 'prompt-visibility.jsonl');
    safeWriteFile(ledgerPath, `${JSON.stringify({ ...record, content: 'secret' })}\n`, {
      encoding: 'utf8',
    });
    expect(() => loadPromptVisibilityLedger(ledgerPath)).toThrow(
      'MISSION_LOG_CORRUPT:prompt_visibility_record'
    );
  });
});
