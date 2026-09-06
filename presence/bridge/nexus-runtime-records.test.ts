import { describe, expect, it } from 'vitest';
import {
  parseNexusBrainProfileRegistry,
  parseNexusSessionMetadata,
  parseNexusSessionResponse,
} from './nexus-runtime-records.js';

describe('Nexus persisted runtime record parsers', () => {
  it('parses the governed brain profile registry and rejects prototype keys', () => {
    const parsed = parseNexusBrainProfileRegistry({
      default_profile: 'gemini',
      profiles: {
        gemini: { cmd: 'gemini', args: ['-y'], env: { KYBERION_MODEL: 'gemini-3' } },
      },
    });
    expect(parsed?.profiles.gemini).toMatchObject({ cmd: 'gemini', args: ['-y'] });
    expect(
      parseNexusBrainProfileRegistry({
        default_profile: 'gemini',
        profiles: {
          gemini: { cmd: 'gemini', args: ['-y'], ['__proto__']: { poisoned: true } },
        },
      })
    ).toBeNull();
  });

  it('rejects an invalid default or malformed profile while keeping a valid catalog usable', () => {
    expect(
      parseNexusBrainProfileRegistry({
        default_profile: 'missing',
        profiles: { gemini: { cmd: 'gemini', args: [] } },
      })
    ).toBeNull();
    expect(
      parseNexusBrainProfileRegistry({
        default_profile: 'gemini',
        profiles: {
          gemini: { cmd: 'gemini', args: [] },
          broken: { cmd: 7, args: [] },
        },
      })?.profiles
    ).toEqual({ gemini: { cmd: 'gemini', args: [] } });
  });

  it('parses session metadata and rejects invalid timestamps', () => {
    expect(
      parseNexusSessionMetadata({ stimulus_id: 'stim-1', ts: '2026-09-04T00:00:00.000Z' })
    ).toMatchObject({ stimulus_id: 'stim-1' });
    expect(parseNexusSessionMetadata({ stimulus_id: 'stim-1', ts: 'invalid' })).toBeNull();
    expect(parseNexusSessionMetadata({ stimulus_id: 7 })).toBeNull();
  });

  it('returns only safe response data for feedback projection', () => {
    expect(parseNexusSessionResponse({ status: 'success', data: { message: 'done' } })).toEqual({
      message: 'done',
    });
    expect(parseNexusSessionResponse({ status: 'success', data: ['not-an-object'] })).toBeNull();
    expect(
      parseNexusSessionResponse({ data: { message: 'x', ['__proto__']: { poisoned: true } } })
    ).toBeNull();
  });
});
