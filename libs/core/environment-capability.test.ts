import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrapManifest,
  loadEnvironmentManifest,
  pathResolver,
  probeManifest,
  registerEnvironmentCapabilityProbe,
  resetEnvironmentCapabilityProbeRegistry,
  verifyReady,
  type EnvironmentManifest,
} from './index.js';

const ROOT = pathResolver.rootDir();

describe('probeManifest', () => {
  beforeEach(() => {
    resetEnvironmentCapabilityProbeRegistry();
  });

  it('reports satisfied / unsatisfied per capability', async () => {
    process.env.PROBE_TEST_ENV = 'set';
    delete process.env.PROBE_TEST_ENV_MISSING;
    registerEnvironmentCapabilityProbe('always-ok', async () => ({ available: true }));
    registerEnvironmentCapabilityProbe('always-bad', async () => ({
      available: false,
      reason: 'forced bad',
    }));
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-a',
      version: 'test',
      capabilities: [
        {
          capability_id: 'cap.env-set',
          kind: 'env-var',
          description: 'env present',
          required_for: ['demo'],
          probe: { kind: 'env', name: 'PROBE_TEST_ENV' },
        },
        {
          capability_id: 'cap.env-missing',
          kind: 'env-var',
          description: 'env absent',
          required_for: ['demo'],
          probe: { kind: 'env', name: 'PROBE_TEST_ENV_MISSING' },
        },
        {
          capability_id: 'cap.always-ok',
          kind: 'binary',
          description: 'plug-in probe ok',
          required_for: ['demo'],
          probe: { kind: 'probe', probe_id: 'always-ok' },
        },
        {
          capability_id: 'cap.always-bad',
          kind: 'binary',
          description: 'plug-in probe bad',
          required_for: ['demo'],
          probe: { kind: 'probe', probe_id: 'always-bad' },
        },
      ],
    };
    const probes = await probeManifest(manifest);
    const byId = Object.fromEntries(probes.map((p) => [p.capability_id, p]));
    expect(byId['cap.env-set'].satisfied).toBe(true);
    expect(byId['cap.env-missing'].satisfied).toBe(false);
    expect(byId['cap.always-ok'].satisfied).toBe(true);
    expect(byId['cap.always-bad'].satisfied).toBe(false);
    expect(byId['cap.always-bad'].reason).toContain('forced bad');
    delete process.env.PROBE_TEST_ENV;
  });

  it('marks capabilities not_applicable when platform mismatched', async () => {
    const otherPlatform: NodeJS.Platform = process.platform === 'darwin' ? 'linux' : 'darwin';
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-b',
      version: 'test',
      capabilities: [
        {
          capability_id: 'cap.platform-only',
          kind: 'binary',
          description: 'only relevant on a different platform',
          required_for: ['demo'],
          applies_to_platforms: [otherPlatform],
          probe: { kind: 'env', name: 'WONT_BE_CHECKED' },
        },
      ],
    };
    const probes = await probeManifest(manifest);
    expect(probes[0].satisfied).toBe(true);
    expect(probes[0].not_applicable).toBe(true);
  });
});

describe('bootstrapManifest dry-run', () => {
  it('does not install when apply=false; receipts list everything as unsatisfied', async () => {
    delete process.env.PROBE_BOOTSTRAP_DRY;
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-c',
      version: 'test',
      capabilities: [
        {
          capability_id: 'cap.dry-run',
          kind: 'env-var',
          description: 'env that will not be set',
          required_for: ['demo'],
          probe: { kind: 'env', name: 'PROBE_BOOTSTRAP_DRY' },
          install: {
            operator_confirmed: false,
            instruction: 'set the env var',
          },
        },
      ],
    };
    const receipt = await bootstrapManifest(manifest, { apply: false });
    expect(receipt.satisfied).toHaveLength(0);
    expect(receipt.unsatisfied[0].reason).toContain('dry run');
    expect(receipt.installs_performed).toHaveLength(0);
  });
});

describe('verifyReady', () => {
  const FIX_MISSION = 'MSN-ENV-CAP-FIXTURE-001';
  const MISSION_DIR = path.join(ROOT, 'active/missions/confidential', FIX_MISSION);

  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.MISSION_ID = FIX_MISSION;
    fs.mkdirSync(path.join(MISSION_DIR, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(MISSION_DIR, 'mission-state.json'),
      JSON.stringify({
        mission_id: FIX_MISSION,
        tier: 'confidential',
        assigned_persona: 'ecosystem_architect',
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(MISSION_DIR, { recursive: true, force: true });
  });

  it('reports ready=false when no receipt exists', () => {
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-d',
      version: 'test',
      capabilities: [],
    };
    const report = verifyReady(manifest, { mission_id: FIX_MISSION });
    expect(report.ready).toBe(false);
  });

  it('reports ready=true after a successful bootstrap', async () => {
    process.env.PROBE_VERIFY_READY = 'set';
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-e',
      version: 'test',
      capabilities: [
        {
          capability_id: 'cap.env-ok',
          kind: 'env-var',
          description: 'env present',
          required_for: ['demo'],
          probe: { kind: 'env', name: 'PROBE_VERIFY_READY' },
        },
      ],
    };
    const receipt = await bootstrapManifest(manifest, {
      mission_id: FIX_MISSION,
      apply: true,
    });
    expect(receipt.unsatisfied).toHaveLength(0);
    expect(receipt.manifest_fingerprint).toHaveLength(64);
    expect(receipt.host_fingerprint).toHaveLength(64);
    expect(receipt.expires_at).toBeTruthy();
    const report = verifyReady(manifest, { mission_id: FIX_MISSION });
    expect(report.ready).toBe(true);
    delete process.env.PROBE_VERIFY_READY;
  });

  it('invalidates a receipt when the manifest fingerprint changes', async () => {
    process.env.PROBE_VERIFY_READY = 'set';
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-f',
      version: 'test',
      capabilities: [
        {
          capability_id: 'cap.env-ok',
          kind: 'env-var',
          description: 'env present',
          required_for: ['demo'],
          probe: { kind: 'env', name: 'PROBE_VERIFY_READY' },
        },
      ],
    };
    await bootstrapManifest(manifest, {
      mission_id: FIX_MISSION,
      apply: true,
    });
    const mutatedManifest = {
      ...manifest,
      capabilities: [
        ...manifest.capabilities,
        {
          capability_id: 'cap.new-guard',
          kind: 'env-var' as const,
          description: 'new requirement',
          required_for: ['demo'],
          probe: { kind: 'env', name: 'PROBE_VERIFY_READY' },
        },
      ],
    };
    const report = verifyReady(mutatedManifest, { mission_id: FIX_MISSION });
    expect(report.ready).toBe(false);
    expect(report.missing.some((m) => m.capability_id === '__manifest_fingerprint__')).toBe(true);
    delete process.env.PROBE_VERIFY_READY;
  });
});

describe('loadEnvironmentManifest', () => {
  it('loads the meeting-participation-runtime manifest from disk', () => {
    const manifest = loadEnvironmentManifest('meeting-participation-runtime');
    expect(manifest.manifest_id).toBe('meeting-participation-runtime');
    expect(manifest.capabilities.length).toBeGreaterThan(0);
    const ids = manifest.capabilities.map((c) => c.capability_id).sort();
    expect(ids).toContain('playwright-chromium');
    expect(ids).toContain('voice-consent');
    expect(ids).toContain('ffmpeg');
  });

  it('throws on unknown manifest id', () => {
    expect(() => loadEnvironmentManifest('does-not-exist-anywhere')).toThrow();
  });
});

describe('listEnvironmentManifestIds', () => {
  it('discovers every manifest in the canonical directory', async () => {
    const { listEnvironmentManifestIds } = await import('./environment-capability.js');
    const ids = listEnvironmentManifestIds();
    expect(ids).toContain('meeting-participation-runtime');
    expect(ids).toContain('kyberion-runtime-baseline');
    expect(ids).toContain('reasoning-backend');
    expect(ids).toContain('knowledge-tier-hygiene');
    expect(ids).toContain('schema-integrity');
    expect(ids).toContain('mos-operator-surface');
  });
});

describe('Kyberion environment manifests load and self-describe', () => {
  const expected = [
    {
      id: 'kyberion-runtime-baseline',
      contains: ['node-runtime', 'pnpm', 'git', 'repo-build'],
    },
    {
      id: 'reasoning-backend',
      contains: ['reasoning-backend.any-real'],
    },
    {
      id: 'knowledge-tier-hygiene',
      contains: ['tier.public', 'tier.confidential', 'tier-hygiene.script'],
    },
    {
      id: 'schema-integrity',
      contains: ['contract-schemas.valid', 'catalogs.consistent', 'governance-rules.valid'],
    },
    {
      id: 'mos-operator-surface',
      contains: ['mos.workspace-installed', 'mos.no-write-contract'],
    },
  ];

  it.each(expected)('loads %s with the expected capability ids', ({ id, contains }) => {
    const manifest = loadEnvironmentManifest(id);
    expect(manifest.manifest_id).toBe(id);
    const ids = manifest.capabilities.map((c) => c.capability_id);
    for (const required of contains) expect(ids).toContain(required);
  });
});

describe('plug-in probes are registered by import side effect', () => {
  it('reasoning-backend.any-real / audit-chain.integrity / repo-build.receipt resolve', async () => {
    // The earlier suite's `resetEnvironmentCapabilityProbeRegistry()`
    // clears registrations; re-arm via the exported installer.
    const { installCoreEnvironmentProbes } = await import('./environment-capability-probes.js');
    installCoreEnvironmentProbes();
    const { probeManifest } = await import('./environment-capability.js');
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-probe-ids',
      version: 'test',
      capabilities: [
        {
          capability_id: 'cap.any-real',
          kind: 'vendor-credential',
          description: 'reasoning-backend',
          required_for: ['demo'],
          probe: { kind: 'probe', probe_id: 'reasoning-backend.any-real' },
        },
        {
          capability_id: 'cap.audit',
          kind: 'binary',
          description: 'audit-chain',
          required_for: ['demo'],
          probe: { kind: 'probe', probe_id: 'audit-chain.integrity' },
        },
        {
          capability_id: 'cap.build',
          kind: 'npm-package',
          description: 'repo-build',
          required_for: ['demo'],
          probe: { kind: 'probe', probe_id: 'repo-build.receipt' },
        },
      ],
    };
    const probes = await probeManifest(manifest);
    // Each probe returned a structured answer (satisfied true/false) —
    // not "no probe registered". The reason field is what unregistered
    // probes return, so we just make sure that string is absent.
    for (const p of probes) {
      expect(p.reason ?? '').not.toMatch(/no probe registered/);
    }
  });
});
