import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installCoreEnvironmentProbes,
  nodeVersionSatisfiesFloor,
  parseEnginesNodeFloor,
  playwrightBrowsersDir,
  probeExplicitReasoningBackend,
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

describe('probeExplicitReasoningBackend (LC-04d: explicit selection is probed specifically)', () => {
  const binaryYes = () => true;
  const binaryNo = () => false;

  it('treats explicit stub as not-real with an actionable reason', async () => {
    const result = await probeExplicitReasoningBackend('stub', {});
    expect(result.available).toBe(false);
    expect(result.reason).toContain('stub');
    expect(result.reason).toContain('reasoning:setup');
  });

  it('anthropic requires ANTHROPIC_API_KEY', async () => {
    await expect(
      probeExplicitReasoningBackend('anthropic', { ANTHROPIC_API_KEY: 'k' })
    ).resolves.toEqual({ available: true });
    const missing = await probeExplicitReasoningBackend('anthropic', {});
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain('ANTHROPIC_API_KEY');
  });

  it('probes the shell runtime for explicit claude-cli even when an API key is present', async () => {
    const result = await probeExplicitReasoningBackend(
      'claude-cli',
      { CLAUDE_API_KEY: 'not-a-shell-health-signal' },
      { claudeProbe: () => ({ available: false, reason: 'placeholder CLI' }) }
    );
    expect(result.available).toBe(false);
    expect(result.reason).toContain('placeholder CLI');
  });

  it('does not treat an empty Claude API key as an available agent backend', async () => {
    const result = await probeExplicitReasoningBackend(
      'claude-agent',
      { CLAUDE_API_KEY: '   ' },
      { claudeProbe: () => ({ available: false, reason: 'not authenticated' }) }
    );
    expect(result.available).toBe(false);
    expect(result.reason).toContain('not authenticated');
  });

  it('probes the grok CLI for grok-cli and normalizes the grok alias', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const recordingProbe = (command: string, args: readonly string[]) => {
      calls.push([command, args]);
      return true;
    };
    await expect(
      probeExplicitReasoningBackend('grok-cli', {}, { binaryProbe: recordingProbe })
    ).resolves.toEqual({ available: true });
    await expect(
      probeExplicitReasoningBackend('grok', {}, { binaryProbe: recordingProbe })
    ).resolves.toEqual({ available: true });
    expect(calls).toEqual([
      ['grok', ['--version']],
      ['grok', ['--version']],
    ]);

    const down = await probeExplicitReasoningBackend('grok-cli', {}, { binaryProbe: binaryNo });
    expect(down.available).toBe(false);
    expect(down.reason).toContain('grok');
  });

  it('does not fall back to a different working backend when the selected one is down', async () => {
    // codex selected but broken; the injected claude probe would succeed —
    // the result must still be unavailable for the *selected* backend.
    const result = await probeExplicitReasoningBackend(
      'codex-cli',
      {},
      { binaryProbe: binaryNo, claudeProbe: () => ({ available: true }) }
    );
    expect(result.available).toBe(false);
    expect(result.reason).toContain('codex');
  });

  it('probes copilot through gh', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    await probeExplicitReasoningBackend(
      'copilot',
      {},
      {
        binaryProbe: (command, args) => {
          calls.push([command, args]);
          return true;
        },
      }
    );
    expect(calls).toEqual([['gh', ['copilot', '--', '--help']]]);
  });

  it('rejects unknown backend modes with a catalog pointer', async () => {
    const result = await probeExplicitReasoningBackend(
      'bogus-backend',
      {},
      { binaryProbe: binaryYes }
    );
    expect(result.available).toBe(false);
    expect(result.reason).toContain('reasoning-backend-policy.json');
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
