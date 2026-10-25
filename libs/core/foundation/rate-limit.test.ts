import { describe, expect, it } from 'vitest';
import {
  MAX_FORWARDED_HOPS,
  normalizeIpAddress,
  parseTrustedProxies,
  resolveClientAddress,
} from './rate-limit.js';

const trusted = (raw: string) => {
  const parsed = parseTrustedProxies(raw);
  expect(parsed.invalid).toEqual([]);
  return parsed.proxies;
};

describe('normalizeIpAddress', () => {
  it('accepts the forms proxies write and rejects everything else', () => {
    expect(normalizeIpAddress(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(normalizeIpAddress('203.0.113.7:4711')).toBe('203.0.113.7');
    expect(normalizeIpAddress('[2001:DB8::17]:4711')).toBe('2001:db8::17');
    expect(normalizeIpAddress('[2001:db8::17]')).toBe('2001:db8::17');
    expect(normalizeIpAddress('fe80::1%en0')).toBe('fe80::1');
    // IPv4-mapped IPv6 in every notation unwraps to the IPv4 address.
    for (const mapped of [
      '::ffff:127.0.0.1',
      '::FFFF:127.0.0.1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:7f00:0001',
      '0:0:0:0:0:ffff:127.0.0.1',
      '0000:0000::ffff:7f00:1',
      '[::ffff:7f00:1]:443',
    ]) {
      expect(normalizeIpAddress(mapped), mapped).toBe('127.0.0.1');
    }
    // Look-alikes that are not IPv4-mapped stay IPv6.
    expect(normalizeIpAddress('::7f00:1')).toBe('::7f00:1');
    expect(normalizeIpAddress('1::ffff:7f00:1')).toBe('1::ffff:7f00:1');
    expect(normalizeIpAddress('::ffff:0:7f00:1')).toBe('::ffff:0:7f00:1');
    expect(normalizeIpAddress('::ffff')).toBe('::ffff');
    for (const bad of [
      '',
      'unknown',
      '_hidden',
      'example.com',
      '999.1.1.1',
      '[2001:db8::17',
      '[2001:db8::17]x',
      '[203.0.113.7]',
      '1.2.3.4:port',
      '1'.repeat(80),
    ]) {
      expect(normalizeIpAddress(bad), bad).toBeNull();
    }
  });
});

describe('parseTrustedProxies', () => {
  it('trusts nobody by default and matches addresses and CIDRs of both families', () => {
    expect(parseTrustedProxies(undefined).proxies.size).toBe(0);
    expect(parseTrustedProxies('').proxies.has('127.0.0.1')).toBe(false);
    const proxies = trusted('127.0.0.1, ::1  10.0.0.0/8,fd7a:115c:a1e0::/48');
    expect(proxies.size).toBe(4);
    expect(proxies.has('127.0.0.1')).toBe(true);
    expect(proxies.has('::ffff:127.0.0.1')).toBe(true);
    expect(proxies.has('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(proxies.has('::ffff:a14:1e28')).toBe(true);
    expect(proxies.has('::1')).toBe(true);
    expect(proxies.has('10.20.30.40')).toBe(true);
    expect(proxies.has('fd7a:115c:a1e0::5')).toBe(true);
    expect(proxies.has('11.0.0.1')).toBe(false);
    expect(proxies.has('not-an-ip')).toBe(false);
  });

  it('translates an IPv4-mapped CIDR prefix to its IPv4 prefix', () => {
    const proxies = trusted('::ffff:10.0.0.0/104, ::ffff:c0a8:100/120, ::ffff:203.0.113.9/128');
    expect(proxies.size).toBe(3);
    expect(proxies.has('10.200.1.1')).toBe(true);
    expect(proxies.has('::ffff:10.200.1.1')).toBe(true);
    expect(proxies.has('11.0.0.1')).toBe(false);
    expect(proxies.has('192.168.1.77')).toBe(true);
    expect(proxies.has('192.168.2.1')).toBe(false);
    expect(proxies.has('203.0.113.9')).toBe(true);
    expect(proxies.has('203.0.113.8')).toBe(false);
    const { invalid } = parseTrustedProxies('::ffff:10.0.0.0/95,::ffff:10.0.0.0/129');
    expect(invalid).toEqual([
      '::ffff:10.0.0.0/95 (an IPv4-mapped network needs a prefix of /96 or longer)',
      '::ffff:10.0.0.0/129',
    ]);
  });

  it('reports invalid entries instead of trusting them', () => {
    const { proxies, invalid } = parseTrustedProxies(
      '127.0.0.1,localhost,10.0.0.0/33,::/129,1.2.3.4/x,*'
    );
    expect(invalid).toEqual(['localhost', '10.0.0.0/33', '::/129', '1.2.3.4/x', '*']);
    expect(proxies.size).toBe(1);
  });
});

describe('resolveClientAddress', () => {
  const proxies = trusted('127.0.0.1,10.0.0.0/8');

  it('ignores forwarded headers from an untrusted peer (spoofing)', () => {
    expect(
      resolveClientAddress({
        peer: '198.51.100.9',
        forwardedFor: '1.1.1.1',
        trustedProxies: proxies,
      })
    ).toBe('198.51.100.9');
    // Nothing declared: even loopback is not believed.
    expect(
      resolveClientAddress({
        peer: '127.0.0.1',
        forwardedFor: '1.1.1.1',
        trustedProxies: parseTrustedProxies('').proxies,
      })
    ).toBe('127.0.0.1');
  });

  it('takes the rightmost untrusted hop, not the client-supplied leftmost value', () => {
    expect(
      resolveClientAddress({
        peer: '::ffff:127.0.0.1',
        forwardedFor: '6.6.6.6, 203.0.113.7',
        trustedProxies: proxies,
      })
    ).toBe('203.0.113.7');
  });

  it('walks a multi-hop chain past every declared proxy', () => {
    expect(
      resolveClientAddress({
        peer: '127.0.0.1',
        // Repeated headers arrive as an array (or joined by Node).
        forwardedFor: ['6.6.6.6, 203.0.113.7', '10.1.2.3, 10.4.5.6'],
        trustedProxies: proxies,
      })
    ).toBe('203.0.113.7');
    // Every hop a proxy: the leftmost proxy is the best known address.
    expect(
      resolveClientAddress({
        peer: '127.0.0.1',
        forwardedFor: '10.1.1.1,10.2.2.2',
        trustedProxies: proxies,
      })
    ).toBe('10.1.1.1');
  });

  it('trusts a mapped-IPv4 hop the same as its IPv4 form', () => {
    expect(
      resolveClientAddress({
        peer: '127.0.0.1',
        forwardedFor: '203.0.113.7, ::ffff:a00:2, [0:0:0:0:0:ffff:10.0.0.3]:80',
        trustedProxies: proxies,
      })
    ).toBe('203.0.113.7');
  });

  it('stops at the nearest trusted address on a malformed, obfuscated or overlong chain', () => {
    const at = (forwardedFor?: string) =>
      resolveClientAddress({ peer: '127.0.0.1', forwardedFor, trustedProxies: proxies });
    expect(at('203.0.113.7, garbage')).toBe('127.0.0.1');
    expect(at('203.0.113.7, unknown, 10.0.0.2')).toBe('10.0.0.2');
    expect(at('_hidden')).toBe('127.0.0.1');
    expect(at('for=203.0.113.7')).toBe('127.0.0.1');
    expect(at(undefined)).toBe('127.0.0.1');
    expect(at('')).toBe('127.0.0.1');
    expect(at(' , ,')).toBe('127.0.0.1');
    const chain = ['203.0.113.7', ...Array.from({ length: MAX_FORWARDED_HOPS }, () => '10.0.0.9')];
    expect(at(chain.join(','))).toBe('10.0.0.9');
  });

  it('falls back to the raw peer when the socket has no IP', () => {
    expect(resolveClientAddress({ peer: undefined, trustedProxies: proxies })).toBe('unknown');
  });
});
