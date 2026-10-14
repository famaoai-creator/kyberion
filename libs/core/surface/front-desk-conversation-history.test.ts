import { describe, it, expect } from 'vitest';
import {
  parseConversationHistory,
  parseFrontDeskArtifactRevisionInput,
} from './front-desk-conversation-history.js';
const artifact = {
  requestId: '00000000-0000-4000-8000-000000000001',
  revision: 64,
  sha256: 'a'.repeat(64),
  format: 'compact',
  canRevise: false,
};
const history = (value: unknown) => ({
  sessionId: 'concierge-' + 'b'.repeat(64),
  pending: 0,
  messages: [{ id: 'report', role: 'secretary', text: 'Verified receipt', artifact: value }],
});
describe('inert verified version history', () => {
  it('retains the completed 64th version without making history unreadable', () => {
    expect(parseConversationHistory(history(artifact))?.messages[0].artifact).toEqual(artifact);
  });
  it('rejects malformed version selection and discards unrelated executable metadata', () => {
    expect(parseConversationHistory(history({ ...artifact, approved: true }))).toBeUndefined();
    const value = { ...history(artifact), approval: { approved: true } };
    expect(parseConversationHistory(value)).not.toHaveProperty('approval');
    expect(
      parseFrontDeskArtifactRevisionInput({
        requestId: artifact.requestId,
        revision: 65,
        sha256: artifact.sha256,
        format: 'compact',
      })
    ).toBeUndefined();
  });
});

describe('inert durable request references', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const value = (requestRefs: unknown, role = 'user') => ({
    sessionId: 'concierge-' + 'b'.repeat(64),
    pending: 0,
    messages: [{ id: id + '-user', role, text: 'Request', requestRefs }],
  });
  it('preserves only a validated bounded reference list', () => {
    expect(parseConversationHistory(value([id]))?.messages[0].requestRefs).toEqual([id]);
  });
  it.each([null, 'id', ['bad'], [id, id], [id, 1], Array(65).fill(id)].map((refs) => ({ refs })))(
    'rejects invalid references %j',
    ({ refs }) => {
      expect(parseConversationHistory(value(refs))).toBeUndefined();
    }
  );
  it('does not attach reference authority to assistant messages', () => {
    expect(parseConversationHistory(value([id], 'secretary'))).toBeUndefined();
  });
});
