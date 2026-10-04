import { describe, expect, it } from 'vitest';
import {
  IngressError,
  assertIngressLocalPort,
  ingressLoopbackTarget,
  joinIngressPublicUrl,
  normalizeIngressPathPrefix,
} from './public-ingress-contract.js';

describe('public-ingress-contract', () => {
  it('normalizes path prefixes and rejects traversal / encoded input', () => {
    expect(normalizeIngressPathPrefix(undefined)).toBe('/');
    expect(normalizeIngressPathPrefix('/')).toBe('/');
    expect(normalizeIngressPathPrefix('/events/')).toBe('/events');
    expect(normalizeIngressPathPrefix('/a/b-c_d.e~f')).toBe('/a/b-c_d.e~f');
    for (const bad of ['events', '/../etc', '/a/./b', '/a%2Fb', '/a?x=1', '/a b', '//']) {
      expect(() => normalizeIngressPathPrefix(bad)).toThrow(IngressError);
    }
  });

  it('only accepts integer ports in range', () => {
    expect(assertIngressLocalPort(8791)).toBe(8791);
    for (const bad of [0, 65536, 1.5, '8791', undefined]) {
      expect(() => assertIngressLocalPort(bad)).toThrow(/INGRESS_INVALID_REQUEST/);
    }
  });

  it('targets loopback with the prefix and joins https public URLs', () => {
    expect(ingressLoopbackTarget(8791, '/events')).toBe('http://127.0.0.1:8791/events');
    expect(ingressLoopbackTarget(8791, '/')).toBe('http://127.0.0.1:8791');
    expect(joinIngressPublicUrl('https://mac.tail1.ts.net', '/events')).toBe(
      'https://mac.tail1.ts.net/events'
    );
    expect(() => joinIngressPublicUrl('http://mac.tail1.ts.net', '/')).toThrow(/https/);
  });
});
