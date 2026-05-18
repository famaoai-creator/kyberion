import { describe, expect, it } from 'vitest';
import {
  buildFallbackEmailDraft,
  extractBodyMarkdownFromDraft,
  extractFirstJsonBlock,
  summarizeEmailSubject,
} from './email-workflow.js';

describe('email-workflow shared helpers', () => {
  it('extracts only the body from a persisted draft envelope', () => {
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

  it('builds a fallback draft with a subject envelope', () => {
    const fallback = buildFallbackEmailDraft({
      to: 'team@example.com',
      subject: 'Re: Weekly update',
      tone: 'clear and concise',
      triageText: 'First triage line\nSecond line',
    });

    expect(fallback.draft_markdown).toContain('To: team@example.com');
    expect(fallback.draft_markdown).toContain('Subject: Re: Weekly update');
    expect(fallback.body_markdown).toContain('Thanks for the update.');
  });

  it('summarizes the first non-heading line for a subject', () => {
    expect(summarizeEmailSubject('# Inbox update\nPlease reply soon')).toBe('Please reply soon');
  });

  it('extracts a JSON object from a fenced block', () => {
    const parsed = extractFirstJsonBlock('before\n```json\n{"to":"team@example.com"}\n```\nafter');
    expect(parsed).toEqual({ to: 'team@example.com' });
  });
});
