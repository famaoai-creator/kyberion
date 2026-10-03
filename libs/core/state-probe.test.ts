import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  evaluateStateProbe,
  probeSpecId,
  probeValueFingerprint,
  type StateProbeSpec,
} from './state-probe.js';

const TEST_ROOT = 'active/shared/tmp/state-probe-tests';

function write(rel: string, content: string): void {
  safeMkdir(`${TEST_ROOT}/${rel.split('/').slice(0, -1).join('/')}`, { recursive: true });
  safeWriteFile(`${TEST_ROOT}/${rel}`, content);
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('file probes', () => {
  it('exists matches present files only', async () => {
    const spec: StateProbeSpec = { type: 'file', path: 'a.txt', expect: 'exists' };
    expect((await evaluateStateProbe(spec, { rootDir: TEST_ROOT })).matched).toBe(false);
    write('a.txt', 'data');
    const hit = await evaluateStateProbe(spec, { rootDir: TEST_ROOT });
    expect(hit.matched).toBe(true);
    expect(hit.fingerprint).not.toBe('absent');
  });

  it('changed requires a baseline then fires on diff', async () => {
    write('b.txt', 'v1');
    const spec: StateProbeSpec = { type: 'file', path: 'b.txt', expect: 'changed' };
    // First evaluation establishes the baseline: no fire.
    const first = await evaluateStateProbe(spec, { rootDir: TEST_ROOT });
    expect(first.matched).toBe(false);
    write('b.txt', 'v2-changed');
    const second = await evaluateStateProbe(spec, {
      rootDir: TEST_ROOT,
      previousFingerprint: first.fingerprint,
    });
    expect(second.matched).toBe(true);
    const third = await evaluateStateProbe(spec, {
      rootDir: TEST_ROOT,
      previousFingerprint: second.fingerprint,
    });
    expect(third.matched).toBe(false);
  });

  it('matches applies the regex to file content', async () => {
    write('c.log', 'ok\nERROR at 10:00\nok');
    const spec: StateProbeSpec = {
      type: 'file',
      path: 'c.log',
      expect: 'matches',
      regex: 'ERROR',
    };
    expect((await evaluateStateProbe(spec, { rootDir: TEST_ROOT })).matched).toBe(true);
    const miss = await evaluateStateProbe({ ...spec, regex: 'CRITICAL' }, { rootDir: TEST_ROOT });
    expect(miss.matched).toBe(false);
    await expect(
      evaluateStateProbe({ type: 'file', path: 'x', expect: 'matches' }, { rootDir: TEST_ROOT })
    ).rejects.toThrow(/regex/);
  });

  it('refuses paths that escape the repository', async () => {
    const spec: StateProbeSpec = {
      type: 'file',
      path: '../../../../../../etc/passwd',
      expect: 'exists',
    };
    await expect(evaluateStateProbe(spec, { rootDir: TEST_ROOT })).rejects.toThrow();
  });
});

describe('service_preset probes', () => {
  const spec: StateProbeSpec = {
    type: 'service_preset',
    service_id: 'github',
    action: 'get_pull',
    params: { owner: 'o', repo: 'r', pull_number: 1 },
    expect: { json_path: 'state', equals: 'closed' },
  };

  it('evaluates json_path + equals through the injected port', async () => {
    const serviceCall = async () => ({ state: 'closed', merged: true });
    const result = await evaluateStateProbe(spec, { serviceCall });
    expect(result.matched).toBe(true);
    expect(result.value).toBe('closed');
  });

  it('not_equals inverts the comparison', async () => {
    const openSpec: StateProbeSpec = {
      ...spec,
      expect: { json_path: 'state', not_equals: 'open' },
    };
    const serviceCall = async () => ({ state: 'closed' });
    expect((await evaluateStateProbe(openSpec, { serviceCall })).matched).toBe(true);
    const stillOpen = async () => ({ state: 'open' });
    expect((await evaluateStateProbe(openSpec, { serviceCall: stillOpen })).matched).toBe(false);
  });

  it('changed diffs fingerprints against the previous evaluation', async () => {
    let state = 'open';
    const changedSpec: StateProbeSpec = { ...spec, expect: { json_path: 'state', changed: true } };
    const serviceCall = async () => ({ state });
    const baseline = await evaluateStateProbe(changedSpec, { serviceCall });
    expect(baseline.matched).toBe(false); // no prior fingerprint = baseline only
    state = 'closed';
    const fired = await evaluateStateProbe(changedSpec, {
      serviceCall,
      previousFingerprint: baseline.fingerprint,
    });
    expect(fired.matched).toBe(true);
  });

  it('fails closed without a serviceCall port', async () => {
    const result = await evaluateStateProbe(spec, {});
    expect(result.matched).toBe(false);
    expect(result.detail).toMatch(/serviceCall/);
  });
});

describe('spec identity', () => {
  it('probeSpecId is stable and order-independent', () => {
    const a = probeSpecId({
      type: 'service_preset',
      service_id: 's',
      action: 'a',
      params: { x: 1, y: 2 },
    });
    const b = probeSpecId({
      type: 'service_preset',
      service_id: 's',
      action: 'a',
      params: { y: 2, x: 1 },
    });
    expect(a).toBe(b);
    expect(probeValueFingerprint({ b: 1, a: 2 })).toBe(probeValueFingerprint({ a: 2, b: 1 }));
  });
});
