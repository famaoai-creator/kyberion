import { describe, expect, it } from 'vitest';

import { extractSurfaceBlocks, sanitizeSurfaceReplyText } from './surface-response-blocks.js';

describe('surface-response-blocks', () => {
  it('removes thought-like preambles from user-facing replies', () => {
    const raw = [
      '**Responding to a user**',
      'I am processing the request internally.',
      '',
      'はい、見えています。何かお手伝いできることはありますか？',
    ].join('\n');

    expect(sanitizeSurfaceReplyText(raw)).toBe(
      'はい、見えています。何かお手伝いできることはありますか？'
    );
  });

  it('keeps user-facing text after extracting blocks', () => {
    const raw = [
      '```a2a',
      '{"header":{"receiver":"nerve-agent","performative":"request"},"payload":{"intent":"test"}}',
      '```',
      '',
      '**Responding to a user**',
      'Thought: drafting a concise answer',
      'analysis: user-visible note about the plan',
      '',
      'はい、見えています。',
    ].join('\n');

    const parsed = extractSurfaceBlocks(raw);
    expect(parsed.a2aMessages).toHaveLength(1);
    expect(parsed.text).toBe(
      [
        'Thought: drafting a concise answer',
        'analysis: user-visible note about the plan',
        '',
        'はい、見えています。',
      ].join('\n')
    );
  });

  it('strips reasoning tags while preserving normal mentions of the tag name', () => {
    const raw = [
      'I will use <think> tags in the prompt when needed.',
      '<think>',
      'internal draft that should not leak',
      '</think>',
      '最終回答です。',
    ].join('\n');

    expect(sanitizeSurfaceReplyText(raw)).toBe(
      ['I will use <think> tags in the prompt when needed.', '最終回答です。'].join('\n')
    );
  });

  it('removes paired reasoning blocks inline', () => {
    const raw = ['ここは残ります。', '<thinking>secret draft</thinking>', 'ここも残ります。'].join(
      '\n'
    );

    expect(sanitizeSurfaceReplyText(raw)).toBe(['ここは残ります。', 'ここも残ります。'].join('\n'));
  });

  it('drops invalid planning packet blocks instead of accepting them', () => {
    const raw = [
      '```planning_packet',
      '{"plan_markdown":"","next_tasks":[]}',
      '```',
      '',
      '最終回答です。',
    ].join('\n');

    const parsed = extractSurfaceBlocks(raw);
    expect(parsed.planningPackets).toHaveLength(0);
    expect(parsed.text).toBe('最終回答です。');
  });

  it('reports parse failures for malformed non-task surface blocks', () => {
    const raw = [
      '```a2a',
      '{not valid json}',
      '```',
      '',
      '```approval',
      '{not valid json}',
      '```',
    ].join('\n');

    const parsed = extractSurfaceBlocks(raw);
    expect(parsed.a2aMessages).toHaveLength(0);
    expect(parsed.approvalRequests).toHaveLength(0);
    expect(parsed.surfaceParseErrors).toEqual([
      expect.stringContaining('a2a block parse failed'),
      expect.stringContaining('approval block parse failed'),
    ]);
  });
});
