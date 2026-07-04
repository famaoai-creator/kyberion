import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installCoreEnvironmentProbes,
  nodeVersionSatisfiesFloor,
  parseEnginesNodeFloor,
  playwrightBrowsersDir,
} from './environment-capability-probes.js';
import { probeManifest, type EnvironmentManifest } from './environment-capability.js';
import * as pathResolver from './path-resolver.js';

describe('parseEnginesNodeFloor', () => {
  it('parses a >= range', () => {
    expect(parseEnginesNodeFloor('>=24.0.0')).toEqual([24, 0, 0]);
    expect(parseEnginesNodeFloor('>= 22.11')).toEqual([22, 11, 0]);
    expect(parseEnginesNodeFloor('>=v20')).toEqual([20, 0, 0]);
  });

  it('parses a caret range', () => {
    expect(parseEnginesNodeFloor('^24.1.0')).toEqual([24, 1, 0]);
  });

  it('returns null when no floor is declared', () => {
    expect(parseEnginesNodeFloor('*')).toBeNull();
    expect(parseEnginesNodeFloor('')).toBeNull();
  });
});

describe('nodeVersionSatisfiesFloor', () => {
  it('accepts versions at or above the floor', () => {
    expect(nodeVersionSatisfiesFloor('v24.0.0', [24, 0, 0])).toBe(true);
    expect(nodeVersionSatisfiesFloor('24.5.1', [24, 0, 0])).toBe(true);
    expect(nodeVersionSatisfiesFloor('v25.0.0', [24, 0, 0])).toBe(true);
    expect(nodeVersionSatisfiesFloor('v24.1.0', [24, 1, 0])).toBe(true);
  });

  it('rejects versions below the floor', () => {
    expect(nodeVersionSatisfiesFloor('v22.14.0', [24, 0, 0])).toBe(false);
    expect(nodeVersionSatisfiesFloor('v23.9.9', [24, 0, 0])).toBe(false);
    expect(nodeVersionSatisfiesFloor('v24.0.9', [24, 1, 0])).toBe(false);
  });
});

describe('node-version.floor probe (wired via kyberion-toolchain style manifest)', () => {
  it('is satisfied on the current runtime (repo engines must accept the CI/dev Node)', async () => {
    installCoreEnvironmentProbes();
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-node-floor',
      version: 'test',
      capabilities: [
        {
          capability_id: 'node-runtime',
          kind: 'binary',
          description: 'node floor',
          required_for: ['demo'],
          probe: { kind: 'probe', probe_id: 'node-version.floor' },
        },
      ],
    };
    const statuses = await probeManifest(manifest);
    expect(statuses).toHaveLength(1);
    // The suite itself runs on a Node that pnpm engines already accepted,
    // so the floor probe must agree with pnpm's gate.
    expect(statuses[0]?.satisfied).toBe(true);
  });
});

describe('playwrightBrowsersDir', () => {
  afterEach(() => {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  });

  it('honors PLAYWRIGHT_BROWSERS_PATH override', () => {
    expect(playwrightBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: '/custom/browsers' })).toBe(
      '/custom/browsers'
    );
  });

  it('maps the special value 0 to node_modules', () => {
    expect(playwrightBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: '0' })).toBe(
      pathResolver.rootResolve('node_modules/playwright-core/.local-browsers')
    );
  });

  it('falls back to the platform cache dir', () => {
    const dir = playwrightBrowsersDir({});
    expect(path.basename(dir)).toBe('ms-playwright');
    expect(path.isAbsolute(dir)).toBe(true);
  });
});

describe('playwright.chromium-browser probe', () => {
  afterEach(() => {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  });

  it('reports an actionable install command when the cache dir is absent', async () => {
    installCoreEnvironmentProbes();
    process.env.PLAYWRIGHT_BROWSERS_PATH = pathResolver.rootResolve(
      'active/shared/tmp/onb02-nonexistent-playwright-cache'
    );
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-playwright',
      version: 'test',
      capabilities: [
        {
          capability_id: 'playwright-chromium',
          kind: 'binary',
          description: 'playwright browsers',
          required_for: ['browser-first-win'],
          optional: true,
          probe: { kind: 'probe', probe_id: 'playwright.chromium-browser' },
        },
      ],
    };
    const statuses = await probeManifest(manifest);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.satisfied).toBe(false);
    expect(statuses[0]?.reason).toContain('pnpm exec playwright install chromium');
  });
});
