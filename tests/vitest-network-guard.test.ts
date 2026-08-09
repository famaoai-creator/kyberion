import http from 'node:http';
import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearVitestNetworkEgressAttempts,
  getVitestNetworkEgressAttempts,
  isVitestNetworkEndpointAllowed,
} from './vitest-network-guard.js';

describe('Vitest network egress guard', () => {
  afterEach(() => clearVitestNetworkEgressAttempts());

  it('fails an unmocked external fetch before opening a connection', async () => {
    await expect(fetch('https://network-egress-guard.invalid/should-fail')).rejects.toThrow(
      'Vitest network egress denied'
    );
    expect(getVitestNetworkEgressAttempts()).toEqual([
      {
        origin: 'https://network-egress-guard.invalid',
        method: 'GET',
        hostname: 'network-egress-guard.invalid',
        port: '443',
      },
    ]);
  });

  it('records the method from a Request input', async () => {
    const request = new Request('https://network-egress-guard.invalid/should-fail', {
      method: 'POST',
    });
    await expect(fetch(request)).rejects.toThrow('Vitest network egress denied');
    expect(getVitestNetworkEgressAttempts()[0]).toMatchObject({ method: 'POST', port: '443' });
  });

  it('blocks Axios and node:http before opening an external connection', async () => {
    await expect(axios.get('https://network-egress-guard.invalid/should-fail')).rejects.toThrow(
      'Vitest network egress denied'
    );
    expect(() => http.request('https://network-egress-guard.invalid/should-fail')).toThrow(
      'Vitest network egress denied'
    );
    expect(getVitestNetworkEgressAttempts()).toHaveLength(2);
  });

  it('requires explicit ports for non-local allowlist entries', () => {
    const previous = process.env.KYBERION_VITEST_NETWORK_ALLOWLIST;
    process.env.KYBERION_VITEST_NETWORK_ALLOWLIST = 'https://allowed.example.test:8443';
    try {
      expect(isVitestNetworkEndpointAllowed('https://allowed.example.test:8443/path')).toBe(true);
      expect(isVitestNetworkEndpointAllowed('https://allowed.example.test:443/path')).toBe(false);
      expect(isVitestNetworkEndpointAllowed('https://other.example.test/path')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KYBERION_VITEST_NETWORK_ALLOWLIST;
      else process.env.KYBERION_VITEST_NETWORK_ALLOWLIST = previous;
    }

    process.env.KYBERION_VITEST_NETWORK_ALLOWLIST = 'https://missing-port.example.test';
    try {
      expect(() =>
        isVitestNetworkEndpointAllowed('https://missing-port.example.test/path')
      ).toThrow('require an explicit port');
    } finally {
      if (previous === undefined) delete process.env.KYBERION_VITEST_NETWORK_ALLOWLIST;
      else process.env.KYBERION_VITEST_NETWORK_ALLOWLIST = previous;
    }
  });

  it('permits localhost through the guard', async () => {
    await expect(fetch('http://127.0.0.1:1/health')).rejects.not.toThrow(
      'Vitest network egress denied'
    );
    expect(getVitestNetworkEgressAttempts()).toEqual([]);
  });
});
