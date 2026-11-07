import { describe, expect, it } from 'vitest';
import {
  MediaEventBuffer,
  assertRealtimeVoiceTransportConsent,
  createRmsFallbackAnimationCue,
  normalizeProviderViseme,
  normalizeVibeVoiceAsrSegments,
  transcriptChunkToMediaEvent,
  validateMediaSessionDescriptor,
} from './realtime-media-session.js';

describe('realtime media session contracts', () => {
  it('validates distinct participant identities without promoting labels', () => {
    expect(() =>
      validateMediaSessionDescriptor({
        session_id: 'meeting-1',
        mode: 'meeting_observer',
        scope: { tenant_slug: 'acme-meeting' },
        participants: [
          { participant_id: 'p1', kind: 'human', display_label: 'Alice' },
          { participant_id: 'p2', kind: 'human', display_label: 'Bob' },
        ],
      })
    ).not.toThrow();
  });

  it('rejects duplicate participants and missing meeting egress consent', () => {
    expect(() =>
      validateMediaSessionDescriptor({
        session_id: 'meeting-1',
        mode: 'meeting_observer',
        scope: { tenant_slug: 'acme-meeting' },
        participants: [
          { participant_id: 'p1', kind: 'human' },
          { participant_id: 'p1', kind: 'human' },
        ],
      })
    ).toThrow(/duplicate participant_id/);

    expect(() =>
      validateMediaSessionDescriptor({
        session_id: 'meeting-1',
        mode: 'meeting_observer',
        participants: [],
      })
    ).toThrow(/tenant scope/);

    expect(() =>
      validateMediaSessionDescriptor({
        session_id: 'meeting-1',
        mode: 'meeting_observer',
        scope: { tenant_slug: 'public' },
        participants: [],
      })
    ).toThrow(/tenant scope/);

    expect(() =>
      assertRealtimeVoiceTransportConsent({
        session: {
          session_id: 'meeting-1',
          mode: 'meeting_participant',
          scope: { tenant_slug: 'acme-meeting' },
          participants: [],
        },
        input_format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
        recording_consent_granted: true,
      })
    ).toThrow(/external provider egress consent/);

    expect(() =>
      assertRealtimeVoiceTransportConsent({
        session: { session_id: 'assistant-1', mode: 'assistant', participants: [] },
        input_format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
        recording_consent_granted: true,
        requires_external_provider_egress: true,
      })
    ).toThrow(/external provider egress consent/);
  });

  it('keeps legacy speaker labels separate from stable speaker ids', () => {
    const event = transcriptChunkToMediaEvent({
      session_id: 'meeting-1',
      event_id: 'evt-1',
      speaker_id: 'spk_0',
      chunk: {
        utterance_id: 'utt-1',
        is_final: true,
        text: 'hello',
        speaker_label: 'Alice',
        emitted_at: '2026-09-16T00:00:00.000Z',
      },
    });
    expect(event.speaker_id).toBe('spk_0');
    expect(event.speaker_label).toBe('Alice');
    expect(event.speaker_status).toBe('tentative');
  });

  it('normalizes VibeVoice-style who/when/what segments', () => {
    const events = normalizeVibeVoiceAsrSegments(
      {
        segments: [
          { speaker_id: 0, start_time: 1.25, end_time: 2.5, text: 'first' },
          { speaker: 'Speaker 1', start: 3, end: 4, text: 'second' },
        ],
      },
      { session_id: 'meeting-1' }
    );
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: 'speaker_attribution',
      speaker_id: 'spk_0',
      status: 'authoritative',
    });
    expect(events[1]).toMatchObject({
      type: 'transcript_final',
      speaker_id: 'spk_0',
      start_ms: 1250,
      end_ms: 2500,
    });
    expect(events[3]).toMatchObject({ speaker_id: 'spk_1', start_ms: 3000 });
    expect(events[3]).toMatchObject({ speaker_label: 'Speaker 1' });
  });

  it('normalizes provider visemes and preserves an RMS fallback', () => {
    const viseme = normalizeProviderViseme({
      provider_id: 'azure',
      viseme_id: 18,
      target_avatar_id: 'avatar-1',
      at_ms: 100,
    });
    expect(viseme).toMatchObject({
      kind: 'viseme',
      source: 'provider',
      payload: { provider_viseme_id: 18, canonical_viseme: 'P' },
    });
    expect(
      createRmsFallbackAnimationCue({
        target_avatar_id: 'avatar-1',
        at_ms: 0,
        mouth_open: 2,
      })
    ).toMatchObject({ kind: 'blendshape', source: 'rms_fallback', payload: { mouth_open: 1 } });
  });

  it('fans out events and evicts only beyond the bounded window', () => {
    const buffer = new MediaEventBuffer('s1', 2);
    const seen: string[] = [];
    const listenerErrors: string[] = [];
    buffer.subscribe(() => {
      throw new Error('projection failed');
    });
    buffer.subscribe((event) => seen.push(event.event_id));
    const safeBuffer = new MediaEventBuffer('s2', 2, (error) => listenerErrors.push(String(error)));
    safeBuffer.subscribe(() => {
      throw new Error('safe projection failed');
    });
    safeBuffer.subscribe((event) => seen.push(`safe:${event.event_id}`));
    const base = {
      session_id: 's1' as const,
      at_ms: 0,
      emitted_at: '2026-09-16T00:00:00.000Z',
      source: 'test',
      type: 'session_started' as const,
    };
    buffer.append({ ...base, event_id: 'e1' });
    buffer.append({ ...base, event_id: 'e2', at_ms: 1 });
    buffer.append({ ...base, event_id: 'e3', at_ms: 2 });
    expect(seen).toEqual(['e1', 'e2', 'e3']);
    expect(buffer.snapshot().map((event) => event.event_id)).toEqual(['e2', 'e3']);
    expect(() => buffer.append({ ...base, event_id: 'e3', at_ms: 3 })).toThrow(/duplicate/);

    safeBuffer.append({ ...base, session_id: 's2', event_id: 'e1' });
    expect(listenerErrors).toHaveLength(1);
    expect(seen).toContain('safe:e1');
  });
});
