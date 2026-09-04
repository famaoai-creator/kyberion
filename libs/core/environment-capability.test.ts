import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrapManifest,
  computeManifestSignature,
  loadEnvironmentManifest,
  pathResolver,
  probeManifest,
  registerEnvironmentCapabilityProbe,
  resolveCapabilityInstall,
  resetEnvironmentCapabilityProbeRegistry,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  verifyManifestSignature,
  verifyReady,
  withExecutionContextAsync,
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

  it('rejects duplicate probe ids and supports disposer-based cleanup', () => {
    const probe = async () => ({ available: true });
    const dispose = registerEnvironmentCapabilityProbe('disposable-probe', probe);
    expect(() => registerEnvironmentCapabilityProbe('disposable-probe', probe)).toThrow(
      /already registered/
    );
    dispose();
    expect(() => registerEnvironmentCapabilityProbe('disposable-probe', probe)).not.toThrow();
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

  it('does not execute command or module probes from an untrusted raw manifest', async () => {
    const marker = path.join(ROOT, 'active/shared/tmp/environment-capability-untrusted-probe');
    fs.rmSync(marker, { force: true });
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-untrusted-executable-probes',
      version: 'test',
      capabilities: [
        {
          capability_id: 'cap.command',
          kind: 'binary',
          description: 'must not execute',
          required_for: ['demo'],
          probe: { kind: 'command', command: 'touch', args: [marker] },
        },
        {
          capability_id: 'cap.module',
          kind: 'npm-package',
          description: 'must not import',
          required_for: ['demo'],
          probe: {
            kind: 'module',
            specifier: `data:text/javascript,process.env.UNTRUSTED_MODULE_RAN='1'`,
          },
        },
      ],
    };
    delete process.env.UNTRUSTED_MODULE_RAN;
    const statuses = await probeManifest(manifest);
    expect(statuses.every((status) => !status.satisfied)).toBe(true);
    expect(statuses.every((status) => status.reason?.includes('governed manifest directory'))).toBe(
      true
    );
    expect(fs.existsSync(marker)).toBe(false);
    expect(process.env.UNTRUSTED_MODULE_RAN).toBeUndefined();
  });

  it('rejects mission-evidence traversal and symlink filenames before reading JSON', async () => {
    const missionId = 'MSN-ENV-PROBE-PATH-001';
    const missionDir = path.join(ROOT, 'active/missions/confidential', missionId);
    const evidenceDir = path.join(missionDir, 'evidence');
    const outside = path.join(ROOT, 'active/shared/tmp/environment-capability-probe-outside.json');
    const symlink = path.join(evidenceDir, 'linked.json');
    await withExecutionContextAsync('mission_controller', async () => {
      safeMkdir(evidenceDir, { recursive: true });
      safeWriteFile(path.join(missionDir, 'mission-state.json'), JSON.stringify({ missionId }));
      safeWriteFile(outside, JSON.stringify({ ready: true }));
      safeSymlinkSync(outside, symlink);
      try {
        const manifest: EnvironmentManifest = {
          manifest_id: 'unit-test-mission-evidence-paths',
          version: 'test',
          capabilities: [
            {
              capability_id: 'cap.traversal',
              kind: 'mission-evidence',
              description: 'reject traversal',
              required_for: ['test'],
              probe: { kind: 'mission-evidence', filename: '../shared.json' },
            },
            {
              capability_id: 'cap.symlink',
              kind: 'mission-evidence',
              description: 'reject symlink',
              required_for: ['test'],
              probe: { kind: 'mission-evidence', filename: 'linked.json' },
            },
          ],
        };
        const statuses = await probeManifest(manifest, { mission_id: missionId });
        expect(statuses[0]).toMatchObject({ satisfied: false });
        expect(statuses[0]?.reason).toContain('single repository-local file name');
        expect(statuses[1]).toMatchObject({ satisfied: false });
        expect(statuses[1]?.reason).toContain('path rejected');
      } finally {
        safeRmSync(missionDir, { recursive: true, force: true });
        safeRmSync(outside, { force: true });
      }
    });
  });

  it('does not treat a mission-evidence directory as a satisfied file probe', async () => {
    const missionId = 'MSN-ENV-PROBE-DIRECTORY-001';
    const missionDir = path.join(ROOT, 'active/missions/confidential', missionId);
    const evidenceDir = path.join(missionDir, 'evidence');
    await withExecutionContextAsync('mission_controller', async () => {
      safeMkdir(path.join(evidenceDir, 'ready.json'), { recursive: true });
      try {
        const manifest: EnvironmentManifest = {
          manifest_id: 'unit-test-mission-evidence-directory',
          version: 'test',
          capabilities: [
            {
              capability_id: 'cap.directory',
              kind: 'mission-evidence',
              description: 'reject directory',
              required_for: ['test'],
              probe: { kind: 'mission-evidence', filename: 'ready.json' },
            },
          ],
        };
        const statuses = await probeManifest(manifest, { mission_id: missionId });
        expect(statuses[0]).toMatchObject({ satisfied: false });
        expect(statuses[0]?.reason).toContain('not a regular file');
      } finally {
        safeRmSync(missionDir, { recursive: true, force: true });
      }
    });
  });
});

describe('platform-specific environment installers', () => {
  it('selects a win32 override while preserving the default installer elsewhere', () => {
    const install = {
      operator_confirmed: true,
      command: 'corepack',
      args: ['enable', 'pnpm'],
      platform_overrides: {
        win32: {
          command: 'winget',
          args: ['install', '--id', 'pnpm.pnpm', '--exact'],
        },
      },
    } as const;

    expect(resolveCapabilityInstall(install, 'darwin')).toMatchObject({
      command: 'corepack',
      args: ['enable', 'pnpm'],
      operator_confirmed: true,
    });
    expect(resolveCapabilityInstall(install, 'win32')).toMatchObject({
      command: 'winget',
      args: ['install', '--id', 'pnpm.pnpm', '--exact'],
      operator_confirmed: true,
    });
  });

  it.each(['kyberion-runtime-baseline', 'kyberion-toolchain'] as const)(
    'declares winget installers for the Windows base toolchain: %s',
    (manifestId) => {
      const manifest = loadEnvironmentManifest(manifestId);
      for (const capabilityId of ['node-runtime', 'pnpm', 'git']) {
        const capability = manifest.capabilities.find(
          (entry) => entry.capability_id === capabilityId
        );
        expect(capability?.install?.platform_overrides?.win32?.command).toBe('winget');
      }
    }
  );
});

describe('bootstrapManifest dry-run', () => {
  it('does not install when apply=false; receipts list everything as unsatisfied', async () => {
    const savedPersona = process.env.KYBERION_PERSONA;
    const savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    delete process.env.PROBE_BOOTSTRAP_DRY;
    try {
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
    } finally {
      if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = savedPersona;
      if (savedRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = savedRole;
    }
  });
});

describe('verifyReady', () => {
  const FIX_MISSION = 'MSN-ENV-CAP-FIXTURE-001';
  const MISSION_DIR = path.join(ROOT, 'active/missions/confidential', FIX_MISSION);
  const receiptPath = (manifestId: string) =>
    path.join(MISSION_DIR, 'evidence', `env-setup-receipt.${manifestId}.json`);

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
      })
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

  it('rejects a manifest id that could escape the receipt directory', () => {
    const manifest = {
      manifest_id: '../outside',
      version: 'test',
      capabilities: [],
    } as unknown as EnvironmentManifest;
    expect(() => verifyReady(manifest, { mission_id: FIX_MISSION })).toThrow(
      'invalid manifest id for receipt path'
    );
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

  it('invalidates an expired receipt', async () => {
    process.env.PROBE_VERIFY_READY = 'set';
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-g',
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
    await bootstrapManifest(manifest, { mission_id: FIX_MISSION, apply: true });
    const receipt = JSON.parse(fs.readFileSync(receiptPath(manifest.manifest_id), 'utf8'));
    receipt.expires_at = '2026-01-01T00:00:00.000Z';
    fs.writeFileSync(receiptPath(manifest.manifest_id), JSON.stringify(receipt, null, 2));

    const report = verifyReady(manifest, { mission_id: FIX_MISSION });
    expect(report.ready).toBe(false);
    expect(report.missing.some((m) => m.capability_id === '__receipt_age__')).toBe(true);
    delete process.env.PROBE_VERIFY_READY;
  });

  it('invalidates a receipt generated on another host fingerprint', async () => {
    process.env.PROBE_VERIFY_READY = 'set';
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-h',
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
    await bootstrapManifest(manifest, { mission_id: FIX_MISSION, apply: true });
    const receipt = JSON.parse(fs.readFileSync(receiptPath(manifest.manifest_id), 'utf8'));
    receipt.host_fingerprint = '0'.repeat(64);
    fs.writeFileSync(receiptPath(manifest.manifest_id), JSON.stringify(receipt, null, 2));

    const report = verifyReady(manifest, { mission_id: FIX_MISSION });
    expect(report.ready).toBe(false);
    expect(report.missing.some((m) => m.capability_id === '__host_fingerprint__')).toBe(true);
    delete process.env.PROBE_VERIFY_READY;
  });

  it('invalidates a receipt with malformed generated_at or expires_at timestamps', async () => {
    process.env.PROBE_VERIFY_READY = 'set';
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-i2',
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
    await bootstrapManifest(manifest, { mission_id: FIX_MISSION, apply: true });
    const receipt = JSON.parse(fs.readFileSync(receiptPath(manifest.manifest_id), 'utf8'));
    receipt.generated_at = 'not-a-date';
    receipt.expires_at = 'also-not-a-date';
    fs.writeFileSync(receiptPath(manifest.manifest_id), JSON.stringify(receipt, null, 2));

    const report = verifyReady(manifest, { mission_id: FIX_MISSION });
    expect(report.ready).toBe(false);
    expect(report.missing.map((m) => m.capability_id)).toEqual(
      expect.arrayContaining([
        '__receipt_generated_at__',
        '__receipt_expires_at__',
        '__receipt_age__',
      ])
    );
    delete process.env.PROBE_VERIFY_READY;
  });

  it('invalidates a receipt with malformed array fields', async () => {
    process.env.PROBE_VERIFY_READY = 'set';
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-i3',
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
    await bootstrapManifest(manifest, { mission_id: FIX_MISSION, apply: true });
    const receipt = JSON.parse(fs.readFileSync(receiptPath(manifest.manifest_id), 'utf8'));
    receipt.satisfied = null;
    receipt.unsatisfied = {};
    receipt.installs_performed = 'nope';
    fs.writeFileSync(receiptPath(manifest.manifest_id), JSON.stringify(receipt, null, 2));

    const report = verifyReady(manifest, { mission_id: FIX_MISSION });
    expect(report.ready).toBe(false);
    expect(report.missing.map((m) => m.capability_id)).toEqual(
      expect.arrayContaining([
        '__receipt_satisfied__',
        '__receipt_unsatisfied__',
        '__receipt_installs_performed__',
      ])
    );
    delete process.env.PROBE_VERIFY_READY;
  });

  it('rejects receipts with unknown persisted fields', async () => {
    process.env.PROBE_VERIFY_READY = 'set';
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-i4',
      version: 'test',
      capabilities: [],
    };
    await bootstrapManifest(manifest, { mission_id: FIX_MISSION, apply: true });
    const receipt = JSON.parse(fs.readFileSync(receiptPath(manifest.manifest_id), 'utf8'));
    receipt.unexpected = true;
    fs.writeFileSync(receiptPath(manifest.manifest_id), JSON.stringify(receipt, null, 2));

    const report = verifyReady(manifest, { mission_id: FIX_MISSION });
    expect(report.ready).toBe(false);
    expect(report.missing).toHaveLength(0);
    delete process.env.PROBE_VERIFY_READY;
  });

  it('blocks on required unsatisfied capabilities but not optional ones', async () => {
    delete process.env.PROBE_VERIFY_REQUIRED_MISSING;
    delete process.env.PROBE_VERIFY_OPTIONAL_MISSING;
    const manifest: EnvironmentManifest = {
      manifest_id: 'unit-test-manifest-i',
      version: 'test',
      capabilities: [
        {
          capability_id: 'cap.required-missing',
          kind: 'env-var',
          description: 'required env absent',
          required_for: ['demo'],
          probe: { kind: 'env', name: 'PROBE_VERIFY_REQUIRED_MISSING' },
        },
        {
          capability_id: 'cap.optional-missing',
          kind: 'env-var',
          description: 'optional env absent',
          required_for: ['demo'],
          optional: true,
          probe: { kind: 'env', name: 'PROBE_VERIFY_OPTIONAL_MISSING' },
        },
      ],
    };
    await bootstrapManifest(manifest, { mission_id: FIX_MISSION, apply: true });
    const report = verifyReady(manifest, { mission_id: FIX_MISSION });
    expect(report.ready).toBe(false);
    expect(report.missing.map((m) => m.capability_id)).toContain('cap.required-missing');
    expect(report.missing.map((m) => m.capability_id)).not.toContain('cap.optional-missing');
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

  it('routes governed checks through the unified check entrypoint', () => {
    for (const [id, expected] of [
      ['schema-integrity', ['contract-schemas', 'catalogs', 'governance-rules']],
      ['knowledge-tier-hygiene', ['tier-hygiene']],
    ] as const) {
      const manifest = loadEnvironmentManifest(id);
      const commands = manifest.capabilities
        .map((capability) => capability.probe)
        .filter((probe) => probe?.kind === 'command')
        .map((probe) => [probe?.command, ...(probe?.args || [])].join(' '));
      for (const gate of expected) {
        expect(commands).toContain(`pnpm -s check -- --only ${gate}`);
      }
      expect(
        commands.some((command) =>
          /run check:(contract-schemas|catalogs|governance-rules|tier-hygiene)/u.test(command)
        )
      ).toBe(false);
    }
  });

  it('throws on unknown manifest id', () => {
    expect(() => loadEnvironmentManifest('does-not-exist-anywhere')).toThrow();
  });

  it('rejects path traversal instead of loading an arbitrary JSON file', () => {
    expect(() => loadEnvironmentManifest('../../package')).toThrow('referenced by id');
  });

  it('rejects symlinked manifests in the governed directory', () => {
    const dir = path.join(ROOT, 'knowledge/product/governance/environment-manifests');
    const link = path.join(dir, 'unit-test-symlink.json');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(dir, 'reasoning-backend.json'), link);
    try {
      expect(() => loadEnvironmentManifest('unit-test-symlink')).toThrow(
        'must not contain symlinks'
      );
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('rejects schema-invalid and non-regular manifest files before use', () => {
    const dir = path.join(ROOT, 'knowledge/product/governance/environment-manifests');
    const invalid = path.join(dir, 'unit-test-schema-invalid.json');
    const directory = path.join(dir, 'unit-test-directory.json');
    const source = JSON.parse(
      fs.readFileSync(path.join(dir, 'reasoning-backend.json'), 'utf8')
    ) as Record<string, unknown>;
    source.unexpected = true;
    fs.writeFileSync(invalid, JSON.stringify(source));
    fs.mkdirSync(directory, { recursive: true });
    try {
      expect(() => loadEnvironmentManifest('unit-test-schema-invalid')).toThrow(
        /Invalid catalog environment-capability-manifest/
      );
      expect(() => loadEnvironmentManifest('unit-test-directory')).toThrow(
        /must be a regular file/
      );
    } finally {
      fs.rmSync(invalid, { force: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('manifest signing (SA-02)', () => {
  const baseManifest: EnvironmentManifest = {
    manifest_id: 'signing-test',
    version: '1.0.0',
    description: 'signing fixture',
    capabilities: [],
  };
  const KEY = 'unit-test-signing-key';

  it('signs and verifies a manifest, and rejects tampering', () => {
    const signature = computeManifestSignature(baseManifest, KEY);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyManifestSignature({ ...baseManifest, signature }, KEY)).toBe(true);
    expect(
      verifyManifestSignature({ ...baseManifest, description: 'tampered', signature }, KEY)
    ).toBe(false);
    expect(verifyManifestSignature({ ...baseManifest, signature }, 'wrong-key')).toBe(false);
    expect(verifyManifestSignature({ ...baseManifest, signature: 'zz' }, KEY)).toBe(false);
    expect(verifyManifestSignature(baseManifest, KEY)).toBe(false);
  });

  it('canonicalization is key-order independent and excludes the signature field', () => {
    const reordered = {
      capabilities: [],
      description: 'signing fixture',
      version: '1.0.0',
      manifest_id: 'signing-test',
      signature: 'ignored',
    } as EnvironmentManifest;
    expect(computeManifestSignature(reordered, KEY)).toBe(
      computeManifestSignature(baseManifest, KEY)
    );
  });

  it('fail-closed: loading an unsigned governed manifest throws when a signing key is set', () => {
    const previous = process.env.KYBERION_MANIFEST_SIGNING_KEY;
    process.env.KYBERION_MANIFEST_SIGNING_KEY = KEY;
    try {
      expect(() => loadEnvironmentManifest('meeting-participation-runtime')).toThrow(
        /missing or invalid signature/
      );
    } finally {
      if (previous === undefined) delete process.env.KYBERION_MANIFEST_SIGNING_KEY;
      else process.env.KYBERION_MANIFEST_SIGNING_KEY = previous;
    }
  });

  it('warn phase: unsigned manifests still load when no signing key is configured', () => {
    const previous = process.env.KYBERION_MANIFEST_SIGNING_KEY;
    delete process.env.KYBERION_MANIFEST_SIGNING_KEY;
    try {
      const manifest = loadEnvironmentManifest('meeting-participation-runtime');
      expect(manifest.manifest_id).toBe('meeting-participation-runtime');
    } finally {
      if (previous === undefined) delete process.env.KYBERION_MANIFEST_SIGNING_KEY;
      else process.env.KYBERION_MANIFEST_SIGNING_KEY = previous;
    }
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
      id: 'kyberion-toolchain',
      contains: ['node-runtime', 'pnpm', 'git', 'typescript-cli', 'tsx-cli', 'vitest-cli'],
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
