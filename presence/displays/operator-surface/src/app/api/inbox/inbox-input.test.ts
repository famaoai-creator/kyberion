import { describe, expect, it } from 'vitest';
import { parseInboxMutationForm, parseInboxMutationInput } from './inbox-input';

describe('inbox mutation input', () => {
  it('normalizes valid JSON input to the mutation contract', () => {
    expect(parseInboxMutationInput({ entry_id: 'INBOX-1', status: 'accepted' })).toEqual({
      ok: true,
      value: { entryId: 'INBOX-1', status: 'accepted' },
    });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing entry id', { status: 'read' }],
    ['empty entry id', { entry_id: '', status: 'read' }],
    ['invalid status', { entry_id: 'INBOX-1', status: 'write' }],
    ['file entry id', { entry_id: new File(['id'], 'entry.txt'), status: 'read' }],
  ])('rejects %s', (_label, value) => {
    expect(parseInboxMutationInput(value).ok).toBe(false);
  });

  it('uses the same contract for form data and rejects file values', () => {
    const form = new FormData();
    form.set('entry_id', 'INBOX-1');
    form.set('status', 'unread');
    expect(parseInboxMutationForm(form)).toEqual({
      ok: true,
      value: { entryId: 'INBOX-1', status: 'unread' },
    });

    form.set('entry_id', new File(['id'], 'entry.txt'));
    expect(parseInboxMutationForm(form).ok).toBe(false);
  });
});
