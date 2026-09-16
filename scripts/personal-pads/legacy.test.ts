import { describe, expect, it } from 'vitest';
import {
  composeLegacyCapture,
  legacyPayloadToAdapterInput,
  toLegacyHandoffProjection,
} from './legacy.js';

describe('legacy pad compatibility seam', () => {
  it('preserves memory target=now through the unified adapter', () => {
    const input = legacyPayloadToAdapterInput('memory-capture', {
      notes: 'capture this',
      tags: ['one', 'two'],
      target: 'now',
      instruction: '整理',
    });
    expect(input.fields).toMatchObject({ target: 'now', tags: 'one, two', instruction: '整理' });
    expect(
      composeLegacyCapture('memory-capture', { notes: 'capture this', target: 'now' }).body
    ).toContain('候補: now');
  });

  it('normalizes meeting attachments and old instruction fields', () => {
    const result = composeLegacyCapture('meeting-notepad', {
      title: 'Review',
      notes: '決定事項',
      instruction: '要約して',
      attachments: [{ name: 'agenda.txt', mime: 'text/plain', data_base64: 'SGk=' }],
    });
    expect(result.body).toContain('決定事項');
    expect(result.payload).toMatchObject({
      instruction: '要約して',
      attachment_name: 'agenda.txt',
    });
    expect(result.artifacts).toHaveLength(1);
  });

  it('keeps empty-submit compatibility for legacy memory and daily routes', () => {
    expect(() => composeLegacyCapture('memory-capture', {})).not.toThrow();
    expect(() => composeLegacyCapture('daily-desk', {})).not.toThrow();
  });

  it('publishes a stable kind and safe payload for legacy follow-up tools', () => {
    const projection = toLegacyHandoffProjection({
      record_id: 'memory-capture-test',
      pad_id: 'memory-capture',
      title: 'title',
      body: 'body',
      created_at: '2026-09-15T00:00:00.000Z',
      updated_at: '2026-09-15T00:00:00.000Z',
      viewer_principal: 'human:alice',
      scope: { scope_kind: 'system', tier: 'public' },
      tier: 'public',
      storage_policy_id: 'pad.public.v1',
      storage_policy_version: '1',
      adapter_id: 'memory-capture.v1',
      adapter_schema_version: '1',
      payload: { target: 'now' },
      artifact_manifest: [],
      artifact_refs: [],
      content_sha256: 'hash',
    });
    expect(projection).toMatchObject({
      kind: 'memory-capture-handoff',
      version: 1,
      pad_id: 'memory-capture',
    });
    expect(projection).not.toHaveProperty('handoff_ref');
  });
});
