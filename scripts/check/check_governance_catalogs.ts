/**
 * Semantic sync gate for directory-source governed catalogs.
 *
 * The `governance-catalogs` ci-gates entry runs this instead of the
 * generator's byte-exact `--check`: byte equality cannot hold during the
 * directory-split transition because every pull_request run merges the PR
 * head with main, and main still carries the pre-normalization format.
 * JSON.parse + deep-equal preserves the real invariant — the committed
 * runtime artifacts must have the same content the directory sources
 * assemble — while tolerating transient format mixing. Post-transition
 * the byte-exact `--check` can be restored.
 */
import { pathResolver } from '@agent/core/path-resolver';

import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { readSafeJsonFile } from '../lib/json-input.js';
import * as nodePath from 'node:path';

type Json = Record<string, unknown>;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  return ak.length === bk.length && ak.every((k) => deepEqual((a as Json)[k], (b as Json)[k]));
}

function readJson(file: string): Json {
  return readSafeJsonFile<Json>(file, file);
}

function assemble(
  dir: string,
  listKey: string,
  orderKey: string,
  fileFor?: (id: string) => string
): Json {
  const index = readJson(nodePath.join(dir, 'index.json'));
  const order = index[orderKey] as string[];
  const sub = listKey === 'authority_role_permissions' ? 'roles' : 'entries';
  const items: Json = {};
  const arr: unknown[] = [];
  for (const id of order) {
    const file = nodePath.join(dir, sub, fileFor ? fileFor(id) : `${id}.json`);
    items[id] = readJson(file);
    arr.push(items[id]);
  }
  const merged: Json = {};
  for (const [k, v] of Object.entries(index)) {
    if (k === orderKey) continue;
    merged[k] = k === listKey ? (sub === 'roles' ? items : arr) : v;
  }
  return merged;
}

const failures: string[] = [];

const policy = assemble(
  'knowledge/product/governance/security-policy',
  'authority_role_permissions',
  'role_order'
);
const livePolicy = readJson(pathResolver.knowledge('product/governance/security-policy.json'));
if (!deepEqual(policy, livePolicy)) failures.push('security-policy.json');

const retentionDir = 'knowledge/product/governance/storage-retention-catalog';
const retention = assemble(
  retentionDir,
  'entries',
  'entry_order',
  (p) => `${Buffer.from(p, 'utf8').toString('hex')}.json`
);
const liveRetention = readJson(
  pathResolver.knowledge('product/governance/storage-retention-catalog.json')
);
if (!deepEqual(retention, liveRetention)) failures.push('storage-retention-catalog.json');

export const main = defineScript({
  name: 'check:governance-catalogs',
  run(context) {
    if (failures.length > 0) {
      throw new ScriptExitError(
        1,
        [
          'governance catalogs drift from directory sources:',
          ...failures.map((f) => `- ${f} is not what the directory sources assemble`),
        ].join('\n')
      );
    }
    context.print(
      'governance catalogs: directory sources and generated artifacts are semantically in sync'
    );
  },
});

if (
  isDirectScript(import.meta.url, 'check_governance_catalogs.ts') ||
  isDirectScript(import.meta.url, 'check_governance_catalogs.js')
)
  void main();
