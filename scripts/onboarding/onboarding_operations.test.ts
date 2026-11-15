import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(__dirname, '../..');

// The module resolves knowledge paths through pathResolver bound to
// KYBERION_ROOT at import time — stage a minimal root per test, exactly the
// operator-notifications fixture pattern.
let tmpRoot: string;
let mod: typeof import('./onboarding_operations.js');

const REQUIRED_FILES = [
  'knowledge/product/governance/surface-provider-manifests.json',
  'knowledge/product/schemas/surface-provider-manifests.schema.json',
  'knowledge/product/governance/runtime-control-policy.json',
  'knowledge/product/schemas/runtime-control-policy.schema.json',
  'knowledge/product/schemas/notification-preferences.schema.json',
  'knowledge/product/governance/event-intake-policy.json',
  'knowledge/product/schemas/event-intake-policy.schema.json',
  'knowledge/product/governance/security-policy.json',
  'knowledge/product/schemas/security-policy.schema.json',
  // The secure-io policy engine gate (agent-policies.yaml) fails closed when
  // no policies are loaded — writes under a fixture root need the real file.
  'knowledge/product/governance/agent-policies.yaml',
];

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `kyberion-ops-${randomUUID()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
  for (const rel of REQUIRED_FILES) {
    fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(tmpRoot, rel));
  }
  process.env.KYBERION_ROOT = tmpRoot;
  vi.resetModules();
  mod = await import('./onboarding_operations.js');
});

afterEach(() => {
  delete process.env.KYBERION_ROOT;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function readPolicy(): { sources: Record<string, { enabled: boolean; secret_key?: string }> } {
  return JSON.parse(
    fs.readFileSync(
      path.join(tmpRoot, 'knowledge/product/governance/event-intake-policy.json'),
      'utf8'
    )
  );
}

function readPrefs(): { default_channel?: { surface: string; target: string } } {
  const p = path.join(tmpRoot, 'knowledge/personal/notification-preferences.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

describe('applyResidentLoopOperations (non-interactive)', () => {
  it('configures the notification channel without prompting', () => {
    const ops = mod.applyResidentLoopOperations({
      notification: { surface: 'inbox', target: 'operator' },
    });
    expect(ops.notification_surface).toBe('inbox');
    expect(readPrefs().default_channel).toEqual({ surface: 'inbox', target: 'operator' });
  });

  it('enables a declared intake source in policy and marks its secret pending', () => {
    const ops = mod.applyResidentLoopOperations({ intake_enable: ['github'] });
    const entry = ops.intake_sources.find((s) => s.source === 'github');
    expect(readPolicy().sources.github.enabled).toBe(true);
    expect(entry?.status).toBe('pending_secret');
    expect(entry?.secret_key).toBe('EVENT_INTAKE_GITHUB_SECRET');
  });

  it('skips undeclared intake sources instead of inventing them', () => {
    const ops = mod.applyResidentLoopOperations({ intake_enable: ['no-such-source'] });
    expect(ops.intake_sources[0]?.status).toBe('skipped');
    expect(readPolicy().sources['no-such-source']).toBeUndefined();
  });

  it('records resident services as pending — apply never spawns installers', () => {
    const ops = mod.applyResidentLoopOperations({ resident_services: 'install' });
    expect(ops.resident_services).toBe('pending');
  });

  it('records defer and absent resident_services as pending; only skip opts out', () => {
    expect(mod.applyResidentLoopOperations({ resident_services: 'defer' }).resident_services).toBe(
      'pending'
    );
    expect(mod.applyResidentLoopOperations({}).resident_services).toBe('pending');
    expect(mod.applyResidentLoopOperations({ resident_services: 'skip' }).resident_services).toBe(
      'skipped'
    );
  });

  it('marks an already-enabled intake source as enabled, not pending_secret', () => {
    // Pre-enable the source in the fixture policy before applying.
    const policyPath = path.join(tmpRoot, 'knowledge/product/governance/event-intake-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      sources: Record<string, { enabled: boolean }>;
    };
    policy.sources.github.enabled = true;
    fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));

    const ops = mod.applyResidentLoopOperations({ intake_enable: ['github'] });
    expect(ops.intake_sources.find((s) => s.source === 'github')?.status).toBe('enabled');
  });
});

describe('operationsNextSteps', () => {
  it('lists the reconcile command when services are pending', () => {
    const steps = mod.operationsNextSteps({
      resident_services: 'pending',
      intake_sources: [],
    });
    expect(steps.some((s) => s.includes('scheduler reconcile --apply'))).toBe(true);
  });

  it('lists the secret introduce command for pending_secret sources', () => {
    const steps = mod.operationsNextSteps({
      resident_services: 'installed',
      intake_sources: [
        { source: 'github', status: 'pending_secret', secret_key: 'EVENT_INTAKE_GITHUB_SECRET' },
      ],
      notification_surface: 'inbox',
    });
    expect(
      steps.some((s) => s.includes('secret introduce event-intake EVENT_INTAKE_GITHUB_SECRET'))
    ).toBe(true);
    expect(steps.some((s) => s.includes('dot intake'))).toBe(true);
  });

  it('warns when no notification channel was configured', () => {
    const steps = mod.operationsNextSteps({ resident_services: 'installed', intake_sources: [] });
    expect(steps.some((s) => s.includes('notification'))).toBe(true);
  });
});

describe('promptResidentLoopOperations (interactive)', () => {
  function deps(answers: string[]) {
    const queue = [...answers];
    return {
      ask: vi.fn(async (_q: string, fallback?: string) => queue.shift() ?? fallback ?? ''),
      print: vi.fn(),
      t: (en: string) => en,
      isAffirmative: (v: string) => v.trim().toLowerCase().startsWith('y'),
      runTask: vi.fn(async () => undefined),
    };
  }

  it('installs services, saves the channel, and enables chosen sources', async () => {
    // answers: services=y, surface=inbox, target=operator, github=y, ci=n, email=n, custom=n
    const d = deps(['y', 'inbox', 'operator', 'y', 'n', 'n', 'n']);
    const ops = await mod.promptResidentLoopOperations(d);
    expect(d.runTask).toHaveBeenCalledWith(
      'scheduler-reconcile',
      expect.arrayContaining(['scheduler', 'reconcile', '--apply'])
    );
    expect(ops.resident_services).toBe('installed');
    expect(ops.notification_surface).toBe('inbox');
    expect(readPrefs().default_channel?.surface).toBe('inbox');
    expect(ops.intake_sources.find((s) => s.source === 'github')?.status).toBe('pending_secret');
    expect(readPolicy().sources.github.enabled).toBe(true);
  });

  it('records pending when the reconcile task fails', async () => {
    const d = deps(['y', 'none', 'n', 'n', 'n', 'n']);
    d.runTask = vi.fn(async () => {
      throw new Error('boom');
    });
    const ops = await mod.promptResidentLoopOperations(d);
    expect(ops.resident_services).toBe('pending');
    expect(ops.notification_surface).toBeUndefined();
  });
});
