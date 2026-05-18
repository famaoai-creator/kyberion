import { describe, expect, it } from 'vitest';
import { extractBodyMarkdownFromDraft } from './email-draft.js';

describe('extractBodyMarkdownFromDraft', () => {
  it('drops the persisted metadata envelope and returns only the reply body', () => {
    const draft = [
      'To: team@example.com',
      'Subject: Re: Weekly update',
      'Tone: clear and concise',
      '',
      'Hi team,',
      '',
      'Here is the reply body.',
      '',
      'Best,',
      'Kyberion',
    ].join('\n');

    expect(extractBodyMarkdownFromDraft(draft)).toBe([
      'Hi team,',
      '',
      'Here is the reply body.',
      '',
      'Best,',
      'Kyberion',
    ].join('\n'));
  });

  it('keeps plain markdown intact when there is no metadata envelope', () => {
    const body = ['Hello', '', '- Item one', '- Item two'].join('\n');

    expect(extractBodyMarkdownFromDraft(body)).toBe(body);
  });

  it('keeps unexpected header formats intact', () => {
    const body = ['From: somebody', '', 'Keep this as-is.'].join('\n');

    expect(extractBodyMarkdownFromDraft(body)).toBe(body);
  });
});
