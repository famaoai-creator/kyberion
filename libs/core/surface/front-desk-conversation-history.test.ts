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
