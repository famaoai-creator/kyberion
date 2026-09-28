import { describe, expect, it } from 'vitest';
import {
  isSafeStructuralDomPath,
  redactObservationText,
  validateBrowserExtensionObservation,
} from './browser-extension-bridge.js';

const validObservation = {
  schema_version: 'browser-observation.v1',
  observation_id: 'OBS-1',
  procedure_id: 'example.read',
  recording_id: 'REC-1',
  lease_id: 'LEASE-1',
  origin: 'https://example.com',
  captured_at: '2026-07-20T00:00:00.000Z',
  source: 'chrome-extension',
  fields: [
    { name: 'Headline', text: 'Daily update', dom_path: 'body > main > article:nth-of-type(1)' },
  ],
};

describe('browser extension observations', () => {
  it('accepts canonical origins and structural paths', () => {
    expect(validateBrowserExtensionObservation(validObservation).valid).toBe(true);
    expect(isSafeStructuralDomPath('body > main > article:nth-of-type(1)')).toBe(true);
    expect(isSafeStructuralDomPath('body > div[data-secret="x"]')).toBe(false);
  });

  it('rejects non-canonical origins and unsafe selectors', () => {
    expect(
      validateBrowserExtensionObservation({ ...validObservation, origin: 'https://example.com/' })
        .valid
    ).toBe(false);
    expect(
      validateBrowserExtensionObservation({
        ...validObservation,
        fields: [{ name: 'x', text: 'y', dom_path: 'body > div[data-id="secret"]' }],
      }).valid
    ).toBe(false);
  });

  it('redacts phone numbers at the server trust boundary', () => {
    const redacted = redactObservationText('連絡先 090-1234-5678 mail user@example.com');
    expect(redacted).toContain('[redacted-phone]');
    expect(redacted).toContain('[redacted-email]');
    expect(redacted).not.toContain('090-1234-5678');
  });
});
