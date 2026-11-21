/**
 * Assemble the high-churn governed catalogs from their directory form.
 *
 * Source of truth lives in per-entry files so independent entries can be
 * reviewed and edited without conflicting on one large file:
 *
 *   knowledge/product/governance/security-policy/
 *     index.json          — every section except `authority_role_permissions`
 *                           (kept as an ordered placeholder) + `role_order`
 *     roles/<role>.json   — one role permission object per file
 *
 *   knowledge/product/governance/storage-retention-catalog/
 *     index.json          — catalog metadata + `entry_order` (path list)
 *     entries/<hex>.json  — one entry per file, named hex(entry.path)
 *
 * The assembled single JSON files remain the runtime artifacts (zero loader
 * change, zero runtime risk). `--check` verifies the committed files are in
 * sync with the directory sources; run without `--check` to regenerate.
 */
import * as nodePath from 'node:path';
import { knowledge } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeReaddir, safeWriteFile } from '@agent/core/secure-io';

const CHECK_MODE = process.argv.includes('--check');

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  return JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string) as Json;
}

function listJsonFiles(dir: string): string[] {
  return safeReaddir(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

async function assemble(dirRel: string, outRel: string, build: (dir: string) => Json): Promise<string> {
  const dir = knowledge(`product/governance/${dirRel}`);
  const out = knowledge(`product/governance/${outRel}`);
  const merged = build(dir);
  // Canonical expanded JSON — deterministic and byte-stable so --check is a
  // strict sync gate. The committed single files were reformatted once in the
  // directory-split PR; semantic content is unchanged.
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  if (!CHECK_MODE) {
    safeWriteFile(out, text, { encoding: 'utf8' });
    console.log(`[governance-catalogs] wrote ${outRel}`);
    return 'written';
  }
  const current = safeExistsSync(out) ? (safeReadFile(out, { encoding: 'utf8' }) as string) : '';
  if (current === text) {
    console.log(`[governance-catalogs] ${outRel} in sync`);
    return 'in-sync';
  }
  console.error(`[governance-catalogs] STALE ${outRel} — run pnpm generate:governance-catalogs`);
  return 'stale';
}

function assembleSecurityPolicy(dir: string): Json {
  const index = readJson(nodePath.join(dir, 'index.json'));
  const roleOrder = index.role_order as string[];
  const rolesDir = nodePath.join(dir, 'roles');
  const onDisk = listJsonFiles(rolesDir).map((f) => f.replace(/\.json$/, ''));
  for (const role of roleOrder) {
    if (!onDisk.includes(role)) {
      throw new Error(`security-policy role_order lists "${role}" but roles/${role}.json is missing`);
    }
  }
  const orphans = onDisk.filter((r) => !roleOrder.includes(r));
  if (orphans.length > 0) {
    throw new Error(`security-policy roles without role_order entry: ${orphans.join(', ')}`);
  }
  const merged: Json = {};
  for (const [key, value] of Object.entries(index)) {
    if (key === 'role_order') continue;
    if (key === 'authority_role_permissions') {
      const perms: Json = {};
      for (const role of roleOrder) {
        perms[role] = readJson(nodePath.join(rolesDir, `${role}.json`));
      }
      merged[key] = perms;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function assembleRetentionCatalog(dir: string): Json {
  const index = readJson(nodePath.join(dir, 'index.json'));
  const entryOrder = index.entry_order as string[];
  const entriesDir = nodePath.join(dir, 'entries');
  const fileFor = (entryPath: string) => `${Buffer.from(entryPath, 'utf8').toString('hex')}.json`;
  const onDisk = listJsonFiles(entriesDir);
  const expected = new Set(entryOrder.map((p) => fileFor(p)));
  for (const f of onDisk) {
    if (!expected.has(f)) {
      throw new Error(`retention catalog entry file ${f} is not referenced by entry_order`);
    }
  }
  const merged: Json = {};
  for (const [key, value] of Object.entries(index)) {
    if (key === 'entry_order') continue;
    if (key === 'entries') {
      merged[key] = entryOrder.map((entryPath) => {
        const file = nodePath.join(entriesDir, fileFor(entryPath));
        if (!safeExistsSync(file)) {
          throw new Error(`retention catalog entry_order lists "${entryPath}" but ${fileFor(entryPath)} is missing`);
        }
        const entry = readJson(file);
        if (entry.path !== entryPath) {
          throw new Error(`retention entry ${fileFor(entryPath)} path mismatch: "${entry.path}" != "${entryPath}"`);
        }
        return entry;
      });
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

const results = await Promise.all([
  assemble('security-policy', 'security-policy.json', assembleSecurityPolicy),
  assemble('storage-retention-catalog', 'storage-retention-catalog.json', assembleRetentionCatalog),
]);

if (CHECK_MODE && results.includes('stale')) {
  process.exit(1);
}
