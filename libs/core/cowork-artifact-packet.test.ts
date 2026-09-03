import { describe, expect, it } from 'vitest';
import { validateCoworkArtifactPacket } from './cowork-artifact-packet.js';

const validPacket = {
  delivery_id: 'COWORK-TEST',
  delivered_at: '2026-06-22T01:00:00Z',
  title: 'Result',
  summary: 'Summary',
  artifacts: [{ content: 'output', content_type: 'text/plain' }],
};

describe('cowork-artifact-packet', () => {
  it('validates the persisted packet shape', () => {
    expect(validateCoworkArtifactPacket(validPacket)).toEqual(validPacket);
  });

  it('rejects an artifact without path or inline content', () => {
    expect(() =>
      validateCoworkArtifactPacket({
        ...validPacket,
        artifacts: [{ content_type: 'text/plain' }],
      })
    ).toThrow(/cowork-artifact-packet/iu);
  });

  it('rejects an artifact that contains both path and inline content', () => {
    expect(() =>
      validateCoworkArtifactPacket({
        ...validPacket,
        artifacts: [{ path: 'output.md', content: 'output', content_type: 'text/plain' }],
      })
    ).toThrow(/cowork-artifact-packet/iu);
  });
});
