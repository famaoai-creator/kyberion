import { describe, expect, it } from 'vitest';
import { parseVoiceRepairSession } from './voice-repair-session.js';

const validSession = {
  version: 1,
  created_at: '2026-09-01T00:00:00.000Z',
  expires_at: '2026-09-02T00:00:00.000Z',
  request_id: 'request-1',
  sample_id: 'sample-1',
  prompt_text: 'hello world',
  initial_recording: { status: 'succeeded', output_path: 'active/shared/tmp/sample.wav' },
  initial_transcript: { transcript: 'hello world', segments: [] },
  verification: { status: 'blocked', mismatches: [], segment_matches: [], expected_segments: [] },
  repair_attempts: [],
  replacements: [],
  next_action: 'record only the listed mismatched segments',
};

describe('parseVoiceRepairSession', () => {
  it('accepts a persisted repair session', () => {
    expect(parseVoiceRepairSession(validSession)).toEqual(validSession);
  });

  it.each([
    null,
    { ...validSession, version: 2 },
    { ...validSession, request_id: '' },
    { ...validSession, initial_transcript: [] },
    {
      ...validSession,
      repair_attempts: [{ segment_id: 'segment-1', attempt: 0, status: 'blocked' }],
    },
    {
      ...validSession,
      replacements: [{ start_sec: 4, end_sec: 3, path: 'repair.wav', segment_id: 'segment-1' }],
    },
  ])('rejects malformed session: %j', (value) => {
    expect(parseVoiceRepairSession(value)).toBeNull();
  });
});
