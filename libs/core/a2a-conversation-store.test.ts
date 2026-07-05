import { afterEach, describe, expect, it } from 'vitest';
import { appendConversationTurn, readConversationHistory } from './a2a-conversation-store.js';
import { pathResolver, safeExistsSync, safeRmSync, withExecutionContext } from '@agent/core';

const CONVERSATION_ID = `CONV-STORE-${Date.now()}`;
const CONVERSATION_FILE = pathResolver.shared(`runtime/a2a-conversations/${CONVERSATION_ID}.jsonl`);

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    const previousSudo = process.env.KYBERION_SUDO;
    process.env.KYBERION_SUDO = 'true';
    try {
      if (safeExistsSync(CONVERSATION_FILE)) {
        safeRmSync(CONVERSATION_FILE, { force: true });
      }
    } finally {
      if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
      else process.env.KYBERION_SUDO = previousSudo;
    }
  });
});

describe('a2a conversation store', () => {
  it('rejects unsafe conversation ids', async () => {
    await expect(
      appendConversationTurn('../escape', {
        sender: 'sender-x',
        receiver: 'agent-y',
        performative: 'request',
      })
    ).rejects.toThrow('Invalid conversation_id');

    expect(() => readConversationHistory('a/b')).toThrow('Invalid conversation_id');
  });

  it('appends and reads safe conversation ids', async () => {
    await appendConversationTurn(CONVERSATION_ID, {
      sender: 'sender-x',
      receiver: 'agent-y',
      performative: 'request',
      prompt: 'hello',
      result: 'world',
      missionId: 'MSN-1',
    });

    const history = readConversationHistory(CONVERSATION_ID);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sender: 'sender-x',
      receiver: 'agent-y',
      performative: 'request',
      prompt: 'hello',
      result: 'world',
    });
  });

  it('preserves concurrent appends to the same conversation', async () => {
    const conversationId = `${CONVERSATION_ID}-CONCURRENT`;
    const messages = Array.from({ length: 20 }, (_, index) => `message-${index}`);

    await Promise.all(
      messages.map((prompt, index) =>
        appendConversationTurn(conversationId, {
          sender: `sender-${index}`,
          receiver: 'agent-y',
          performative: 'request',
          prompt,
          result: `result-${index}`,
          missionId: 'MSN-1',
        })
      )
    );

    const history = readConversationHistory(conversationId);
    expect(history).toHaveLength(messages.length);
    expect(new Set(history.map((turn) => turn.prompt))).toEqual(new Set(messages));
  });
});
