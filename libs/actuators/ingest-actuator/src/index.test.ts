// DA-04: dispatch wiring — handleAction supports both the actuator
// 'pipeline' action (parse → normalize chained through {{context}} refs,
// object-safe) and direct op calls, mirroring email-actuator's surface.
import { describe, expect, it } from 'vitest';
import { handleAction } from './index.js';
import type { NormalizeCardResult } from './normalize-card.js';

describe('ingest-actuator handleAction', () => {
  it('runs a parse → normalize pipeline with object-safe {{var}} wiring', async () => {
    const ctx = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'parse_document',
          params: {
            content_text: '# Pipeline Card\n\nWired body.',
            format: 'markdown',
            source_meta: { source_system: 'confluence', source_id: 'PAGE-9' },
            export_as: 'ir',
          },
        },
        {
          type: 'transform',
          op: 'normalize_card',
          params: {
            ir: '{{ir}}',
            target: { relative_path: 'knowledge/product/governance/pipeline-card.md' },
            now: '2026-07-28T00:00:00.000Z',
            export_as: 'card',
          },
        },
      ],
      context: {},
    });
    const card = ctx.card as NormalizeCardResult;
    expect(card.target_path).toBe('knowledge/product/governance/pipeline-card.md');
    expect(card.frontmatter.title).toBe('Pipeline Card');
    expect(card.frontmatter.kind).toBe('governance');
    expect(card.frontmatter.source_id).toBe('PAGE-9');
  });

  it('defaults capture exports to last_capture (run_pipeline capture gate)', async () => {
    const ctx = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'parse_document',
          params: { content_text: 'plain text', format: 'text' },
        },
      ],
      context: {},
    });
    expect(ctx.last_capture).toMatchObject({ text_markdown: 'plain text' });
  });

  it('supports direct op calls', async () => {
    const result = await handleAction({
      action: 'parse_document',
      params: { content_text: '# Direct\n\nCall.', format: 'markdown' },
    });
    expect(result.status).toBe('succeeded');
    expect(result.last_capture).toMatchObject({ title: 'Direct' });
  });

  it('rejects unknown ops', async () => {
    await expect(handleAction({ action: 'not_an_op', params: {} })).rejects.toThrow(
      /unknown op: not_an_op/
    );
  });
});
