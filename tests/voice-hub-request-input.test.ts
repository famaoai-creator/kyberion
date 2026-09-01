import { describe, expect, it } from 'vitest';
import {
  parseVoiceBridgeResponse,
  parseVoiceTranscriptionResponse,
  readVoiceHubEventScope,
  readVoiceHubRequestObject,
} from '../satellites/voice-hub/request-input.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('voice-hub request input boundary', () => {
  it('rejects null, arrays, and primitive JSON values', () => {
    for (const value of [null, [], 'text', 42, true]) {
      expect(() => readVoiceHubRequestObject(value)).toThrow('request body must be a JSON object');
    }
  });

  it('accepts an object and preserves its fields', () => {
    const body = { text: 'hello', auto_reply: false };
    expect(readVoiceHubRequestObject(body)).toBe(body);
  });

  it('uses the foundation record predicate for every object response boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/voice-hub/request-input.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("import { isRecord } from '@agent/core/foundation';");
    expect(source).not.toContain('function isRecord(');
  });

  it('strictly validates the optional event scope', () => {
    expect(readVoiceHubEventScope(undefined)).toBeUndefined();
    expect(readVoiceHubEventScope({ tier: 'public', scope_kind: 'system' })).toEqual({
      tier: 'public',
      scope_kind: 'system',
    });
    expect(() => readVoiceHubEventScope({ tenant_slug: [] })).toThrow('EVENT_SCOPE_INPUT_INVALID');
  });

  it('routes scope through the strict parser before processing', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/voice-hub/server.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('readVoiceHubEventScope');
    expect(source).toContain('normalizeEventScope(parsedScope)');
    expect(source).not.toContain('(body.scope as EventScopeInput)');
  });

  it('rejects malformed bridge and transcription responses', () => {
    expect(parseVoiceBridgeResponse({ status: 'success', text: 'hello' })).toEqual({
      status: 'success',
      text: 'hello',
    });
    expect(parseVoiceBridgeResponse({ status: 'success', text: [] })).toBeUndefined();
    expect(parseVoiceBridgeResponse([])).toBeUndefined();
    expect(parseVoiceTranscriptionResponse({ text: 'hello', segments: [] })).toEqual({
      text: 'hello',
    });
    expect(parseVoiceTranscriptionResponse({ text: 42 })).toBeUndefined();
    expect(parseVoiceTranscriptionResponse(null)).toBeUndefined();
  });

  it('uses response normalizers before treating provider output as successful', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/voice-hub/server.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toMatch(/parseVoiceBridgeResponse\(\s*parseSafeJsonInput\(/u);
    expect(source).toContain('parseVoiceTranscriptionResponse(await response.json())');
    expect(source).not.toContain('as { text?: string }');
  });
});
