import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeServicePreset: vi.fn(),
}));

vi.mock('./service-engine.js', () => ({
  executeServicePreset: mocks.executeServicePreset,
}));

import {
  executeEmailDelivery,
  executeOutlookDelivery,
  listOutlookInbox,
  organizeOutlookInbox,
} from './email-workflow.js';

describe('email account adapters', () => {
  beforeEach(() => {
    mocks.executeServicePreset.mockReset();
    mocks.executeServicePreset.mockImplementation(async (_service: string, action: string) => {
      if (action === 'auth_status') return { status: 'Logged in' };
      return {};
    });
  });

  it('routes an Outlook new message through the Microsoft Graph preset', async () => {
    await executeEmailDelivery({
      account: 'outlook',
      approved: true,
      draft_mode: false,
      body_markdown: 'Hello from Kyberion',
      subject: 'Status update',
      to: 'a@example.com, b@example.com',
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('m365', 'outlook_send', {
      body: {
        message: {
          subject: 'Status update',
          body: { contentType: 'Text', content: 'Hello from Kyberion' },
          toRecipients: [
            { emailAddress: { address: 'a@example.com' } },
            { emailAddress: { address: 'b@example.com' } },
          ],
        },
        saveToSentItems: true,
      },
    });
  });

  it('creates and updates an Outlook reply draft through the adapter', async () => {
    mocks.executeServicePreset.mockImplementation(async (_service: string, action: string) => {
      if (action === 'auth_status') return { status: 'Logged in' };
      if (action === 'outlook_create_reply') return { id: 'draft-1' };
      return { id: 'draft-1' };
    });

    await executeEmailDelivery({
      account: 'outlook',
      approved: true,
      draft_mode: true,
      reply_mode: 'reply',
      message_id: 'message-1',
      body_markdown: 'A drafted reply',
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('m365', 'outlook_message_update', {
      message_id: 'draft-1',
      body: { body: { contentType: 'Text', content: 'A drafted reply' } },
    });
  });

  it('normalizes Outlook inbox messages and only archives explicit IDs', async () => {
    mocks.executeServicePreset.mockImplementation(async (_service: string, action: string) => {
      if (action === 'outlook_messages_list') {
        return {
          value: [
            {
              id: 'message-1',
              subject: 'Notice',
              from: { emailAddress: { name: 'Sender', address: 'sender@example.com' } },
              receivedDateTime: '2026-07-24T00:00:00Z',
              bodyPreview: 'Preview',
              isRead: false,
            },
          ],
        };
      }
      return { ok: true };
    });

    await expect(listOutlookInbox({ max_messages: 10 })).resolves.toEqual([
      expect.objectContaining({ id: 'message-1', sender_email: 'sender@example.com' }),
    ]);
    await expect(organizeOutlookInbox({ apply: true })).rejects.toThrow('explicit message_ids');
    await expect(
      organizeOutlookInbox({ apply: true, message_ids: ['message-1'] })
    ).resolves.toEqual(expect.objectContaining({ archived_message_ids: ['message-1'] }));
    expect(mocks.executeServicePreset).toHaveBeenCalledWith('m365', 'outlook_message_move', {
      message_id: 'message-1',
      body: { destinationId: 'archive' },
    });
  });
});
