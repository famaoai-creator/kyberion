/**
 * Assemble the high-churn governed catalogs from their directory form.
 *
 * Source of truth lives in per-entry files so independent entries can be
 * reviewed and edited without conflicting on one large JSON:
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
 * change, zero runtime risk). The `governance-catalogs` pr gate runs
 * `--check` so committed artifacts cannot drift from the directory sources.
 * Both artifacts are .prettierignore'd: canonical JSON.stringify output is
 * compared byte-for-byte.
 */
import * as nodePath from 'node:path';
import { knowledge } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { defineGenerator, isDirectScript } from '../lib/harness.js';
import { readSafeJsonFile } from '../lib/json-input.js';

type Json = Record<string, unknown>;

const SP_DIR = 'product/governance/security-policy';
const SP_OUT = 'product/governance/security-policy.json';
const RC_DIR = 'product/governance/storage-retention-catalog';
const RC_OUT = 'product/governance/storage-retention-catalog.json';

function readJson(file: string): Json {
  return readSafeJsonFile<Json>(file, file);
}

function listJsonFiles(dir: string): string[] {
  return safeReaddir(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

function assembleSecurityPolicy(): Json {
  const dir = knowledge(SP_DIR);
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

function assembleRetentionCatalog(): Json {
  const dir = knowledge(RC_DIR);
  const index = readJson(nodePath.join(dir, 'index.json'));
  const entryOrder = index.entry_order as string[];
  const entriesDir = nodePath.join(dir, 'entries');
  const fileFor = (entryPath: string) => `${Buffer.from(entryPath, 'utf8').toString('hex')}.json`;
  const expected = new Set(entryOrder.map((p) => fileFor(p)));
  for (const f of listJsonFiles(entriesDir)) {
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
          throw new Error(
            `retention catalog entry_order lists "${entryPath}" but ${fileFor(entryPath)} is missing`
          );
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

export const main = defineGenerator({
  id: 'governance-catalogs',
  outputs: [knowledge(SP_OUT), knowledge(RC_OUT)],
  render() {
    return [
      { path: knowledge(SP_OUT), content: `${JSON.stringify(assembleSecurityPolicy(), null, 2)}\n` },
      { path: knowledge(RC_OUT), content: `${JSON.stringify(assembleRetentionCatalog(), null, 2)}\n` },
    ];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_governance_catalogs.ts') ||
  isDirectScript(import.meta.url, 'generate_governance_catalogs.js')
)
  void main();
