import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertSafePackUrl,
  discoverPackPluginDirs,
  importPluginPack,
  listPackImportRecords,
  loadPluginPackRegistry,
  normalizePackImportRecord,
  packIdFromUrl,
} from './plugin-pack.js';
import { pathResolver } from './path-resolver.js';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';

describe('plugin packs (QM-07)', () => {
  describe('assertSafePackUrl', () => {
    it('accepts plain https URLs', () => {
      expect(() => assertSafePackUrl('https://github.com/acme/skill-pack')).not.toThrow();
    });

    it('rejects non-https schemes, userinfo, IPs and local hosts', () => {
      expect(() => assertSafePackUrl('http://github.com/x')).toThrow(/https/);
      expect(() => assertSafePackUrl('git@github.com:acme/x.git')).toThrow(/invalid/);
      expect(() => assertSafePackUrl('https://user:pw@github.com/x')).toThrow(/userinfo/);
      expect(() => assertSafePackUrl('https://192.168.1.10/x')).toThrow(/public DNS/);
      expect(() => assertSafePackUrl('https://localhost/x')).toThrow(/public DNS/);
      expect(() => assertSafePackUrl('https://nas.local/x')).toThrow(/public DNS/);
    });

    it('rejects numeric/hex loopback shorthands and trailing-dot localhost (review A6)', () => {
      expect(() => assertSafePackUrl('https://2130706433/x')).toThrow(/public DNS/);
      expect(() => assertSafePackUrl('https://0x7f000001/x')).toThrow(/public DNS/);
      expect(() => assertSafePackUrl('https://127.1/x')).toThrow(/public DNS/);
      expect(() => assertSafePackUrl('https://localhost./x')).toThrow(/public DNS/);
    });
  });

  it('derives stable pack ids from URLs', () => {
    expect(packIdFromUrl('https://github.com/Acme/Skill-Pack.git')).toBe(
      'github-com-acme-skill-pack'
    );
  });

  it('normalizes persisted import records and rejects malformed shapes', () => {
    expect(normalizePackImportRecord([])).toBeUndefined();
    expect(
      normalizePackImportRecord({
        pack_id: 'pack',
        at: 'now',
        ok: true,
        url: 'https://github.com/acme/pack',
        installed: ['plugin-a'],
        archived: [],
        skipped: [{ plugin_id: 'plugin-b', reason: 'collision' }],
      })
    ).toMatchObject({ pack_id: 'pack', installed: ['plugin-a'] });
    expect(
      normalizePackImportRecord({
        pack_id: 'pack',
        at: 'now',
        ok: 'true',
        url: 'https://github.com/acme/pack',
        installed: [],
        archived: [],
        skipped: [],
      })
    ).toBeUndefined();
  });

  describe('import lifecycle against a local fixture', () => {
    let fixtureDir: string;
    let registryDir: string;
    let managedRoot: string;

    const writePlugin = (name: string) => {
      const dir = path.join(fixtureDir, name);
      safeMkdir(dir, { recursive: true });
      safeWriteFile(
        path.join(dir, 'plugin-manifest.json'),
        JSON.stringify({ name, version: '1.0.0', description: `${name} fixture` })
      );
    };

    beforeEach(() => {
      const stamp = randomUUID();
      fixtureDir = pathResolver.sharedTmp(`qm07-pack-${stamp}`);
      registryDir = pathResolver.sharedTmp(`qm07-registry-${stamp}`);
      managedRoot = pathResolver.sharedTmp(`qm07-managed-${stamp}`);
      safeMkdir(fixtureDir, { recursive: true });
      writePlugin('pack-plugin-a');
      writePlugin('pack-plugin-b');
    });

    afterEach(() => {
      for (const dir of [fixtureDir, registryDir, managedRoot]) {
        safeRmSync(dir, { recursive: true, force: true });
      }
    });

    const doImport = () =>
      importPluginPack({
        url: fixtureDir,
        allowLocalPath: true,
        registryDir,
        managedRoot,
        requestedBy: 'qm07-test',
      });

    it('imports every plugin through the provenance-gated managed install', () => {
      const result = doImport();
      expect(result.importRecord.ok).toBe(true);
      expect(result.importRecord.installed.sort()).toEqual(['pack-plugin-a', 'pack-plugin-b']);
      // Pack sources are third-party by construction — never auto-activatable.
      for (const record of result.installed) {
        expect(record.activationStatus).toBe('pending_approval');
      }
      const registry = loadPluginPackRegistry(registryDir);
      expect(registry.packs).toHaveLength(1);
      expect(registry.packs[0]?.plugins.map((plugin) => plugin.status)).toEqual([
        'active',
        'active',
      ]);
      expect(listPackImportRecords(10, registryDir)).toHaveLength(1);
    });

    it('archives upstream-removed plugins instead of deleting them', () => {
      doImport();
      safeRmSync(path.join(fixtureDir, 'pack-plugin-b'), { recursive: true, force: true });
      const second = doImport();
      expect(second.importRecord.archived).toEqual(['pack-plugin-b']);
      const pack = loadPluginPackRegistry(registryDir).packs[0]!;
      const archived = pack.plugins.find((plugin) => plugin.plugin_id === 'pack-plugin-b');
      expect(archived?.status).toBe('archived');
      expect(archived?.archived_at).toBeTruthy();
      expect(listPackImportRecords(10, registryDir)).toHaveLength(2);
    });

    it('never claims a plugin id owned by another pack', () => {
      doImport();
      const otherFixture = pathResolver.sharedTmp(`qm07-pack2-${randomUUID()}`);
      safeMkdir(path.join(otherFixture, 'pack-plugin-a'), { recursive: true });
      safeWriteFile(
        path.join(otherFixture, 'pack-plugin-a', 'plugin-manifest.json'),
        JSON.stringify({ name: 'pack-plugin-a', version: '2.0.0', description: 'impostor' })
      );
      try {
        const result = importPluginPack({
          url: otherFixture,
          allowLocalPath: true,
          registryDir,
          managedRoot,
        });
        expect(result.importRecord.installed).toEqual([]);
        expect(result.importRecord.skipped[0]).toMatchObject({
          plugin_id: 'pack-plugin-a',
          reason: expect.stringContaining('claimed by pack'),
        });
      } finally {
        safeRmSync(otherFixture, { recursive: true, force: true });
      }
    });

    it('refuses a colliding pack id registered for a different URL (review B2)', () => {
      doImport();
      // Same basename under a different parent → same derived pack_id,
      // different url — the impostor must be refused, not merged.
      const impostorParent = pathResolver.sharedTmp(`qm07-impostor-${randomUUID()}`);
      const impostorDir = path.join(impostorParent, path.basename(fixtureDir));
      safeMkdir(path.join(impostorDir, 'impostor-plugin'), { recursive: true });
      safeWriteFile(
        path.join(impostorDir, 'impostor-plugin', 'plugin-manifest.json'),
        JSON.stringify({ name: 'impostor-plugin', version: '1.0.0', description: 'impostor' })
      );
      try {
        expect(() =>
          importPluginPack({ url: impostorDir, allowLocalPath: true, registryDir, managedRoot })
        ).toThrow(/different URL/);
        const registry = loadPluginPackRegistry(registryDir);
        expect(registry.packs).toHaveLength(1);
        expect(registry.packs[0]?.url).toBe(fixtureDir);
      } finally {
        safeRmSync(impostorParent, { recursive: true, force: true });
      }
    });

    it('one broken plugin is skipped and recorded, not a pack-poisoning abort (review B1)', () => {
      safeMkdir(path.join(fixtureDir, 'bad plugin name!'), { recursive: true });
      safeWriteFile(
        path.join(fixtureDir, 'bad plugin name!', 'plugin-manifest.json'),
        JSON.stringify({ name: 'bad', version: '1.0.0', description: 'invalid dir name' })
      );
      const result = doImport();
      expect(result.importRecord.ok).toBe(true);
      expect(result.importRecord.installed.sort()).toEqual(['pack-plugin-a', 'pack-plugin-b']);
      expect(result.importRecord.skipped[0]).toMatchObject({
        plugin_id: 'bad plugin name!',
        reason: expect.stringContaining('install failed'),
      });
      const again = doImport();
      expect(again.importRecord.installed.sort()).toEqual(['pack-plugin-a', 'pack-plugin-b']);
    });

    it('records failed imports too (a pack with no plugins)', () => {
      const emptyDir = pathResolver.sharedTmp(`qm07-empty-${randomUUID()}`);
      safeMkdir(emptyDir, { recursive: true });
      try {
        expect(() =>
          importPluginPack({ url: emptyDir, allowLocalPath: true, registryDir, managedRoot })
        ).toThrow(/no plugin directories/);
        const records = listPackImportRecords(10, registryDir);
        expect(records.at(-1)).toMatchObject({ ok: false });
      } finally {
        safeRmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('skips malformed persisted import lines when listing history', () => {
      doImport();
      const importLog = path.join(registryDir, 'pack-imports.jsonl');
      const current = String(safeReadFile(importLog, { encoding: 'utf8' }));
      safeWriteFile(
        importLog,
        `${current}${JSON.stringify([])}\n${JSON.stringify({ ok: true })}\n{"meta":{"__proto__":{}}}\n`
      );

      expect(listPackImportRecords(10, registryDir)).toHaveLength(1);
    });

    it('discovers plugins at root, subdirs and plugins/ layouts', () => {
      const nested = pathResolver.sharedTmp(`qm07-nested-${randomUUID()}`);
      safeMkdir(path.join(nested, 'plugins', 'inner-plugin'), { recursive: true });
      safeWriteFile(
        path.join(nested, 'plugins', 'inner-plugin', 'plugin-manifest.json'),
        JSON.stringify({ name: 'inner-plugin', version: '1.0.0', description: 'nested' })
      );
      try {
        const dirs = discoverPackPluginDirs(nested);
        expect(dirs.map((entry) => entry.pluginId)).toContain('inner-plugin');
      } finally {
        safeRmSync(nested, { recursive: true, force: true });
      }
    });

    it('discovers a portable Agent Plugins v1 root plugin.json', () => {
      const portable = pathResolver.sharedTmp(`qm07-portable-${randomUUID()}`);
      safeMkdir(portable, { recursive: true });
      safeWriteFile(
        path.join(portable, 'plugin.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/knowledge/product/schemas/1.0.0/plugin.schema.json',
          name: 'portable-root-plugin',
        })
      );
      try {
        expect(discoverPackPluginDirs(portable)).toEqual([
          { pluginId: 'portable-root-plugin', dir: portable },
        ]);
      } finally {
        safeRmSync(portable, { recursive: true, force: true });
      }
    });

    it('does not use a symlinked manifest during pack discovery', () => {
      const root = pathResolver.sharedTmp(`qm07-symlink-manifest-${randomUUID()}`);
      const target = pathResolver.sharedTmp(`qm07-symlink-manifest-target-${randomUUID()}.json`);
      safeMkdir(root, { recursive: true });
      safeWriteFile(target, JSON.stringify({ name: 'outside-manifest' }));
      safeSymlinkSync(target, path.join(root, 'plugin.json'));
      try {
        expect(discoverPackPluginDirs(root)).toEqual([]);
      } finally {
        safeRmSync(root, { recursive: true, force: true });
        safeRmSync(target, { force: true });
      }
    });

    it('imports a local portable root package using its manifest name', () => {
      const portable = pathResolver.sharedTmp(`qm07-portable-import-${randomUUID()}`);
      const localRegistry = pathResolver.sharedTmp(`qm07-portable-registry-${randomUUID()}`);
      const localManagedRoot = pathResolver.sharedTmp(`qm07-portable-managed-${randomUUID()}`);
      safeMkdir(portable, { recursive: true });
      safeWriteFile(
        path.join(portable, 'plugin.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/knowledge/product/schemas/1.0.0/plugin.schema.json',
          name: 'portable-import-plugin',
        })
      );
      try {
        const result = importPluginPack({
          url: portable,
          allowLocalPath: true,
          registryDir: localRegistry,
          managedRoot: localManagedRoot,
          requestedBy: 'qm07-test',
        });
        expect(result.importRecord.installed).toEqual(['portable-import-plugin']);
      } finally {
        safeRmSync(portable, { recursive: true, force: true });
        safeRmSync(localRegistry, { recursive: true, force: true });
        safeRmSync(localManagedRoot, { recursive: true, force: true });
      }
    });
  });

  it('rejects a registry directory that traverses a symbolic link', () => {
    const target = pathResolver.sharedTmp(`qm07-registry-target-${randomUUID()}`);
    const linked = pathResolver.sharedTmp(`qm07-registry-link-${randomUUID()}`);
    const fileTarget = pathResolver.sharedTmp(`qm07-registry-file-target-${randomUUID()}.json`);
    const fileLinkDir = pathResolver.sharedTmp(`qm07-registry-file-link-${randomUUID()}`);
    safeMkdir(target, { recursive: true });
    safeSymlinkSync(target, linked, 'dir');
    safeMkdir(fileLinkDir, { recursive: true });
    safeWriteFile(fileTarget, JSON.stringify({ version: '1', packs: [] }));
    safeSymlinkSync(fileTarget, path.join(fileLinkDir, 'packs.json'));
    try {
      expect(() => loadPluginPackRegistry(linked)).toThrow(/RESOURCE_PATH_SYMLINK/);
      expect(() => loadPluginPackRegistry(fileLinkDir)).toThrow(/RESOURCE_PATH_SYMLINK/);
    } finally {
      safeRmSync(linked, { recursive: true, force: true });
      safeRmSync(target, { recursive: true, force: true });
      safeRmSync(fileLinkDir, { recursive: true, force: true });
      safeRmSync(fileTarget, { recursive: true, force: true });
    }
  });
});
