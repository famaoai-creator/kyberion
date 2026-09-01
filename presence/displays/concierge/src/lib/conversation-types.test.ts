import { describe, expect, it } from 'vitest';
import { parseVoiceHubConversationResponse } from './conversation-types';

describe('voice-hub conversation response parser', () => {
  it('selects a typed reply from a valid endpoint root', () => {
    const result = parseVoiceHubConversationResponse({ replyText: '  hello  ' });
    expect(result).toEqual({ reply: 'hello' });
  });

  it('rejects malformed endpoint response fields before delivery', () => {
    expect(parseVoiceHubConversationResponse([])).toBeUndefined();
    expect(parseVoiceHubConversationResponse({ reply: { text: 'bad' } })).toBeUndefined();
    expect(
      parseVoiceHubConversationResponse({ reply: 'hello', intentResolution: [] })
    ).toBeUndefined();
    expect(parseVoiceHubConversationResponse({ reply: '   ' })).toBeUndefined();
  });
});
