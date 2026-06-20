import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeServicePreset: vi.fn(),
}));

vi.mock('./service-engine.js', () => ({
  executeServicePreset: mocks.executeServicePreset,
}));

import { organizeGmailInboxWithFilters, parseEmailAddressHeader } from './email-workflow.js';

describe('email inbox archive workflow', () => {
  beforeEach(() => {
    mocks.executeServicePreset.mockReset();
  });

  it('parses sender headers into display names and emails', () => {
    expect(parseEmailAddressHeader('Vendor Updates <updates@example.com>')).toEqual({
      display_name: 'Vendor Updates',
      email: 'updates@example.com',
    });
    expect(parseEmailAddressHeader('alerts@example.com')).toEqual({
      display_name: 'alerts@example.com',
      email: 'alerts@example.com',
    });
  });

  it('builds a preview archive plan without mutating mailbox state', async () => {
    mocks.executeServicePreset.mockImplementation(async (_serviceId: string, action: string, request: any) => {
      if (action === 'gmail_messages_list') {
        expect(request.params.q).toBe('in:inbox is:unread');
        return {
          messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
        };
      }
      if (action === 'gmail_message_get') {
        if (request.params.id === 'm1' || request.params.id === 'm2') {
          return {
            id: request.params.id,
            payload: {
              headers: [
                { name: 'From', value: 'Vendor Updates <updates@example.com>' },
                { name: 'Subject', value: request.params.id === 'm1' ? 'Digest 1' : 'Digest 2' },
              ],
            },
          };
        }
        return {
          id: 'm3',
          payload: {
            headers: [
              { name: 'From', value: 'Team Lead <lead@example.com>' },
              { name: 'Subject', value: 'Project note' },
            ],
          },
        };
      }
      if (action === 'gmail_filters_list') {
        return { filter: [] };
      }
      if (action === 'gmail_filters_create' || action === 'gmail_messages_batch_modify') {
        throw new Error('preview mode must not mutate mailbox state');
      }
      throw new Error(`unexpected action: ${action}`);
    });

    const result = await organizeGmailInboxWithFilters({
      max_messages: 10,
      min_count: 2,
      apply: false,
    });

    expect(result.applied).toBe(false);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.find((candidate) => candidate.sender_email === 'updates@example.com')?.will_create_filter).toBe(true);
    expect(result.candidates.find((candidate) => candidate.sender_email === 'updates@example.com')?.will_archive_messages).toBe(true);
    expect(result.archived_message_ids).toEqual(expect.arrayContaining(['m1', 'm2']));
    expect(result.created_filters).toHaveLength(0);
    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'google-workspace',
      'gmail_messages_list',
      expect.objectContaining({
        params: expect.objectContaining({ q: 'in:inbox is:unread', maxResults: 10 }),
      }),
    );
  });

  it('creates filters and archives matched messages when apply is set', async () => {
    mocks.executeServicePreset.mockImplementation(async (_serviceId: string, action: string, request: any) => {
      if (action === 'gmail_messages_list') {
        return {
          messages: [{ id: 'm1' }, { id: 'm2' }],
        };
      }
      if (action === 'gmail_message_get') {
        return {
          id: request.params.id,
          payload: {
            headers: [
              { name: 'From', value: 'Newsletter <news@example.com>' },
              { name: 'Subject', value: 'Weekly digest' },
            ],
          },
        };
      }
      if (action === 'gmail_filters_list') {
        return { filter: [] };
      }
      if (action === 'gmail_filters_create') {
        return { id: 'filter-1' };
      }
      if (action === 'gmail_messages_batch_modify') {
        return { success: true };
      }
      throw new Error(`unexpected action: ${action}`);
    });

    const result = await organizeGmailInboxWithFilters({
      max_messages: 10,
      min_count: 2,
      apply: true,
    });

    expect(result.applied).toBe(true);
    expect(result.created_filters).toEqual([
      expect.objectContaining({
        sender_email: 'news@example.com',
        filter_id: 'filter-1',
      }),
    ]);
    expect(result.archived_message_ids).toEqual(['m1', 'm2']);
    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'google-workspace',
      'gmail_filters_create',
      expect.objectContaining({
        params: { userId: 'me' },
        body: expect.objectContaining({
          criteria: { from: 'news@example.com' },
          action: { removeLabelIds: ['INBOX'] },
        }),
      }),
    );
    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'google-workspace',
      'gmail_messages_batch_modify',
      expect.objectContaining({
        params: { userId: 'me' },
        body: expect.objectContaining({
          ids: ['m1', 'm2'],
          removeLabelIds: ['INBOX'],
        }),
      }),
    );
  });
});
