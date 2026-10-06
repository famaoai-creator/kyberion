import { describe, expect, it } from 'vitest';
import {
  parseFirstJobRequest,
  parseFirstJobReadRequest,
  parseFirstJobArtifactReadRequest,
} from './first-job-contract.js';
const request_id = '00000000-0000-4000-8000-000000000001';
const artifactRevision = {
  requestId: request_id,
  revision: 1,
  sha256: 'a'.repeat(64),
  format: 'compact',
};
describe('bounded first-job protocol', () => {
  it('accepts only fixed actions and immutable revision identity', () => {
    expect(parseFirstJobRequest({ action: 'start', request_id })).toEqual({
      action: 'start',
      request_id,
    });
    expect(parseFirstJobRequest({ action: 'revise', request_id, artifactRevision })).toEqual({
      action: 'revise',
      request_id,
      artifactRevision,
    });
    expect(parseFirstJobReadRequest({ locale: 'en-US' })).toEqual({ locale: 'en-US' });
    expect(parseFirstJobReadRequest({ locale: 'zz' })).toEqual({ locale: 'zz' });
  });
  it.each([
    null,
    [],
    {},
    { action: 'start' },
    { action: 'approve', request_id },
    { action: 'revise', request_id },
    { action: 'start', request_id, artifactRevision },
    { action: 'start', request_id, text: 'confidential customer data' },
    { action: 'start', request_id, tier: 'personal' },
    { action: 'start', request_id, tenant: 'other-tenant' },
    { action: 'start', request_id, headers: { principalId: 'owner' } },
    { action: 'start', request_id, approved: true },
    { action: 'start', request_id, principalId: 'human:other' },
    { action: 'start', request_id, locale: '' },
    { action: 'start', request_id, locale: 'a'.repeat(33) },
    { action: 'start', request_id, session_id: 'arbitrary' },
    { action: 'start', request_id: '../unsafe' },
    {
      action: 'revise',
      request_id,
      artifactRevision: { ...artifactRevision, outputPath: '/tmp/private' },
    },
    { action: 'revise', request_id, artifactRevision: { ...artifactRevision, format: 'html' } },
  ])('rejects unsupported or privileged input %#', (value) => {
    expect(parseFirstJobRequest(value)).toBeUndefined();
  });
  it.each([
    { tenant: 'other' },
    { tier: 'public' },
    { principalId: 'owner' },
    { locale: ['en'] },
    { session_id: 'x' },
  ])('does not accept authority or malformed GET fields %#', (value) => {
    expect(parseFirstJobReadRequest(value)).toBeUndefined();
  });
});

describe('bounded diagnostic artifact selectors', () => {
  const selector = {
    session_id: 'concierge-' + 'a'.repeat(64),
    request_id,
    revision: '1',
    sha256: 'b'.repeat(64),
  };
  it('parses the exact immutable identity only', () => {
    expect(parseFirstJobArtifactReadRequest(selector)).toEqual({ ...selector, revision: 1 });
  });
  it.each([
    { path: '/etc/passwd' },
    { artifactPath: '../private' },
    { tenant: 'other' },
    { tier: 'personal' },
    { locale: 'en' },
    { revision: '0' },
    { revision: '-1' },
    { revision: '1.0' },
    { revision: '01' },
    { revision: '1e2' },
    { revision: 1 },
    { revision: ['1'] },
    { revision: '9999999999' },
    { request_id: '../secret' },
    { sha256: 'abc' },
    { session_id: ['concierge-' + 'a'.repeat(64)] },
  ])('rejects extra authority, paths and malformed identity %#', (override) => {
    expect(parseFirstJobArtifactReadRequest({ ...selector, ...override })).toBeUndefined();
  });
  it('requires all fields', () => {
    for (const key of Object.keys(selector)) {
      const missing = { ...selector } as Record<string, unknown>;
      delete missing[key];
      expect(parseFirstJobArtifactReadRequest(missing)).toBeUndefined();
    }
  });
});
