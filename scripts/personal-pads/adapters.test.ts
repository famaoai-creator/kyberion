import { describe, expect, it } from 'vitest';
import { assertPadAdaptersComplete, getPadAdapter, PAD_ADAPTERS } from './adapters.js';
import { PAD_IDS } from './registry.js';

describe('personal pad adapter seam', () => {
  it('covers every menu entry without server branches', () => {
    assertPadAdaptersComplete();
    expect(PAD_ADAPTERS.map((adapter) => adapter.pad_id)).toEqual([...PAD_IDS]);
  });

  it('composes each pad input through its adapter contract', () => {
    for (const padId of PAD_IDS) {
      const adapter = getPadAdapter(padId);
      const seedField = adapter.fields[0]?.id;
      const parsed = adapter.parseInput({
        body: '本文',
        fields: adapter.body_mode === 'freeform' || !seedField ? {} : { [seedField]: 'demo' },
      });
      expect(() => adapter.validateInput(parsed)).not.toThrow();
      expect(adapter.renderPreview({ ...parsed, fields: { tags: 'demo' } })).toBeTruthy();
      const result = adapter.composeCapture({
        body: '本文',
        fields: {
          tags: 'demo',
          next_action: '確認',
          attendees: 'A',
          decisions: '決定',
          handoff: 'Bへ',
          instruction: '図',
          drawing_data: 'drawn',
          source: 'clipboard',
          url: 'https://example.com',
          journal: 'journal',
          todo: 'todo',
          now: 'now',
          file_name: 'notes.md',
          review_note: '確認',
          image_name: 'screen.png',
          annotation: '注釈',
          entry_type: 'task',
          due: '2026-09-30',
        },
      });
      expect(result.body).toBeTruthy();
    }
  });

  it('rejects an empty adapter submission', () => {
    expect(() => getPadAdapter('meeting-notepad').composeCapture({ body: '', fields: {} })).toThrow(
      'capture input is required'
    );
  });

  it('promotes managed file and canvas data into typed artifacts', () => {
    const png = Buffer.from('png-bytes').toString('base64');
    const sketch = getPadAdapter('sketch-input').composeCapture({
      body: '',
      fields: { drawing_data: `data:image/png;base64,${png}` },
    });
    expect(sketch.artifacts).toMatchObject([
      { field_id: 'drawing_data', mime: 'image/png', data_base64: png },
    ]);
    expect(sketch.body).toContain('描画データを添付');
    expect(sketch.body).not.toContain('data:image/png;base64');
    const meeting = getPadAdapter('meeting-notepad').composeCapture({
      body: '',
      fields: {
        attendees: 'Alice',
        audio_name: 'meeting.webm',
        audio_name_data: `data:audio/webm;base64,${png}`,
        attachment_name: 'agenda.md',
        attachment_name_data: `data:text/markdown;base64,${png}`,
      },
    });
    expect(meeting.artifacts[0]).toMatchObject({ field_id: 'audio_name', name: 'meeting.webm' });
    expect(meeting.artifacts[1]).toMatchObject({
      field_id: 'attachment_name',
      name: 'agenda.md',
    });
  });

  it('preserves multiple original attachments through one generic file field', () => {
    const first = Buffer.from('first').toString('base64');
    const second = Buffer.from('second').toString('base64');
    const result = getPadAdapter('doc-drop').composeCapture({
      body: '',
      fields: {
        file_name: 'one.md\ntwo.md',
        file_name_name_0: 'one.md',
        file_name_name_1: 'two.md',
        file_name_data: `data:text/markdown;base64,${first}`,
        file_name_data_1: `data:text/markdown;base64,${second}`,
      },
    });
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual(['one.md', 'two.md']);
    expect(result.payload).toMatchObject({
      file_name_data: `data:text/markdown;base64,${first}`,
      file_name_data_1: `data:text/markdown;base64,${second}`,
    });
  });

  it('accepts typed action fields as a restorable workbench capture', () => {
    const result = getPadAdapter('personal-workbench').composeCapture({
      body: '',
      fields: {
        email_to: 'alice@example.com',
        email_subject: '確認',
        email_body: '本文',
      },
    });
    expect(result.body).toContain('期限:');
    expect(result.payload).toMatchObject({ email_body: '本文' });
  });

  it('declares screenshot annotation as a reusable image-overlay field', () => {
    const field = getPadAdapter('screenshot-annotate').fields.find(
      (candidate) => candidate.id === 'annotation_data'
    );
    expect(field).toEqual(
      expect.objectContaining({
        id: 'annotation_data',
        kind: 'drawing',
        overlay_field: 'image_name',
      })
    );
    expect(field?.drawing_tools?.map((tool) => tool.id)).toEqual([
      'pen',
      'rect',
      'arrow',
      'text',
      'eraser',
    ]);
    expect(
      getPadAdapter('screenshot-annotate').fields.find((candidate) => candidate.id === 'annotation')
        ?.voice_input
    ).toEqual(expect.objectContaining({ label: '🎤 音声入力' }));
    expect(field?.download).toEqual(
      expect.objectContaining({ filename: 'screenshot-annotate.png' })
    );
    expect(
      getPadAdapter('screenshot-annotate').fields.find((candidate) => candidate.id === 'image_name')
        ?.paste_drop
    ).toBe(true);
  });
});
