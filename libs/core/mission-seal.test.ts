/**
 * AL-02 hermetic tests for `sealMission`: sealed outputs (`.enc`/`.key.enc`)
 * are durable artifacts written to `<missionDir>/seal/` (which the finish-flow
 * archive `cp -r` lands at `active/archive/missions/<ID>/seal/`), while
 * intermediates (tarball, symmetric key, anchor input) still pass through
 * `active/shared/tmp/` and are removed before returning.
 *
 * Hermetic: a temp KYBERION_ROOT is set BEFORE importing repo modules
 * (path-resolver binds its root at import time). `safeExec` is mocked so no
 * tar/openssl/node child processes are spawned. Raw fs seeds/inspects the
 * temp root (registered in tests/core-fs-exception-boundary.test.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExec: (command: string, args: string[] = []) => {
      if (command === 'tar' && args[0] === '-czf') {
        // args: -czf <archivePath> -C <parentDir> <baseName>
        fs.mkdirSync(path.dirname(args[1]!), { recursive: true });
        fs.writeFileSync(args[1]!, `tarball-of:${args[4]}`);
        return '';
      }
      if (command === 'openssl' && args[0] === 'rand') {
        fs.writeFileSync(args[2]!, 'symmetric-key-bytes');
        return '';
      }
      if (command === 'openssl' && args[0] === 'enc') {
        const inPath = args[args.indexOf('-in') + 1]!;
        const outPath = args[args.indexOf('-out') + 1]!;
        fs.writeFileSync(outPath, `ENC(${fs.readFileSync(inPath, 'utf8')})`);
        return '';
      }
      if (command === 'openssl' && args[0] === 'rsautl') {
        const inPath = args[args.indexOf('-in') + 1]!;
        const outPath = args[args.indexOf('-out') + 1]!;
        fs.writeFileSync(outPath, `RSA(${fs.readFileSync(inPath, 'utf8')})`);
        return '';
      }
      if (command === 'node') {
        // blockchain-actuator anchor call — best-effort, emulate success.
        return '';
      }
      throw new Error(`unexpected safeExec in mission-seal test: ${command} ${args.join(' ')}`);
    },
  };
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmpRoot: string;
let mod: typeof import('./mission-seal.js');

const MISSION_ID = 'M-SEAL-AL02';

/** secure-io's policy engine fails closed without policies — seed the real file. */
function seedPolicyFile(root: string): void {
  const target = path.join(root, 'knowledge', 'product', 'governance', 'agent-policies.yaml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'knowledge/product/governance/agent-policies.yaml'), target);
  const schemaTarget = path.join(
    root,
    'knowledge',
    'product',
    'schemas',
    'mission-management.schema.json'
  );
  fs.mkdirSync(path.dirname(schemaTarget), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'knowledge/product/schemas/mission-management.schema.json'),
    schemaTarget
  );
}

describe('sealMission (AL-02)', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyb-mission-seal-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    seedPolicyFile(tmpRoot);
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.MISSION_ROLE = 'mission_controller';

    // Mission tree (legacy active/missions/<ID> path is what findMissionPath
    // resolves when mission-management-config.json is absent).
    const missionDir = path.join(tmpRoot, 'active', 'missions', MISSION_ID);
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(
      path.join(missionDir, 'mission-state.json'),
      JSON.stringify({ mission_id: MISSION_ID, status: 'completed' })
    );

    // Public key presence gates sealing; openssl is mocked so any bytes do.
    const keyDir = path.join(tmpRoot, 'vault', 'keys');
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, 'sovereign-public.pem'), 'dummy-public-key');

    mod = await import('./mission-seal.js');
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    delete process.env.MISSION_ROLE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes .enc and .key.enc into <missionDir>/seal/ (not shared tmp) and cleans intermediates', async () => {
    const result = await mod.sealMission(MISSION_ID);

    const sealDir = path.join(tmpRoot, 'active', 'missions', MISSION_ID, 'seal');
    expect(result).toBe(path.join(sealDir, `${MISSION_ID}.enc`));
    expect(fs.readFileSync(path.join(sealDir, `${MISSION_ID}.enc`), 'utf8')).toBe(
      `ENC(tarball-of:${MISSION_ID})`
    );
    expect(fs.readFileSync(path.join(sealDir, `${MISSION_ID}.key.enc`), 'utf8')).toBe(
      'RSA(symmetric-key-bytes)'
    );

    // Intermediates passed through tmp and were removed before returning.
    const tmpMissionDir = path.join(tmpRoot, 'active', 'shared', 'tmp', 'missions', MISSION_ID);
    expect(fs.existsSync(path.join(tmpMissionDir, `${MISSION_ID}.tar.gz`))).toBe(false);
    expect(fs.existsSync(path.join(tmpMissionDir, `${MISSION_ID}.key`))).toBe(false);
    // No sealed outputs on the 24h-TTL tmp floor.
    expect(fs.existsSync(path.join(tmpMissionDir, `${MISSION_ID}.enc`))).toBe(false);
    expect(fs.existsSync(path.join(tmpMissionDir, `${MISSION_ID}.key.enc`))).toBe(false);
    // Anchor input was cleaned up too.
    const leftovers = fs.existsSync(tmpMissionDir) ? fs.readdirSync(tmpMissionDir) : [];
    expect(leftovers.filter((f) => f.startsWith('anchor-'))).toEqual([]);
  });

  it('re-seal replaces the previous seal and never seals a seal into the tarball', async () => {
    const sealDir = path.join(tmpRoot, 'active', 'missions', MISSION_ID, 'seal');
    fs.writeFileSync(path.join(sealDir, 'stale-marker'), 'old');

    const result = await mod.sealMission(MISSION_ID);
    expect(result).toBe(path.join(sealDir, `${MISSION_ID}.enc`));
    expect(fs.existsSync(path.join(sealDir, 'stale-marker'))).toBe(false);
    expect(fs.readFileSync(path.join(sealDir, `${MISSION_ID}.enc`), 'utf8')).toBe(
      `ENC(tarball-of:${MISSION_ID})`
    );
  });

  it('missionSealArchiveDir resolves the post-archive seal location from mission-management-config', () => {
    // No config in the temp root → default archive area.
    expect(mod.missionSealArchiveDir('M-X')).toBe(
      path.join(tmpRoot, 'active', 'archive', 'missions', 'M-X', 'seal')
    );

    // Config-declared archive dir is honored.
    const configPath = path.join(
      tmpRoot,
      'knowledge',
      'product',
      'governance',
      'mission-management-config.json'
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: '1.1.0', directories: { archive: 'custom/archive/root' } })
    );
    expect(mod.missionSealArchiveDir('M-X')).toBe(
      path.join(tmpRoot, 'custom', 'archive', 'root', 'M-X', 'seal')
    );
    fs.rmSync(configPath);
  });

  it('rejects a mission id that could create a nested archive path', () => {
    expect(() => mod.missionSealArchiveDir('../outside')).toThrow('[MISSION_SEAL_SCOPE]');
  });

  it('returns undefined when the mission does not exist', async () => {
    expect(await mod.sealMission('M-DOES-NOT-EXIST')).toBeUndefined();
  });

  it('skips sealing (returns undefined) when the public key is missing', async () => {
    const keyPath = path.join(tmpRoot, 'vault', 'keys', 'sovereign-public.pem');
    const backup = fs.readFileSync(keyPath);
    fs.rmSync(keyPath);
    try {
      expect(await mod.sealMission(MISSION_ID)).toBeUndefined();
    } finally {
      fs.writeFileSync(keyPath, backup);
    }
  });
});
