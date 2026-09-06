#!/usr/bin/env node
/**
 * Contract Semver Check
 *
 * Detects when an actuator's structural surface (capability ops, contract schema)
 * has changed without a corresponding semver bump.
 *
 * Modes:
 *   pnpm check:contract-semver               # check mode (CI)
 *   pnpm check:contract-semver -- --rebaseline   # update baseline (intentional bumps)
 *
 * Baseline file: scripts/contract-baseline.json
 *
 * The fingerprint is intentionally coarse for v1: it detects op removal/addition
 * and any change in the referenced contract schema. Finer-grained semver classification
 * (e.g. "added required field" vs "added optional field") is a follow-up.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir, safeStat, safeWriteFile } from '@agent/core/secure-io';
import { nowIso, readJson, readTextFile } from '@agent/core/foundation';
import { withExecutionContext } from '@agent/core/governance';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';
import { readSafeJsonFile } from './lib/json-input.js';

interface Manifest {
  actuator_id: string;
  version: string;
  description?: string;
  contract_schema?: string;
  capabilities: Array<{ op: string; platforms: string[] }>;
}

interface ActuatorFingerprint {
  actuator_id: string;
  version: string;
  ops: string[];
  contract_schema: string | null;
  contract_schema_sha256: string | null;
}

interface BaselineFile {
  generated_at: string;
  generator_note: string;
  actuators: ActuatorFingerprint[];
}

interface BumpKind {
  level: 'none' | 'patch' | 'minor' | 'major';
  reasons: string[];
}

const ACTUATOR_DIR = pathResolver.rootResolve('libs/actuators');
const BASELINE_PATH = resolveCiGateBaselinePath('contract-semver');

function listActuatorManifests(): string[] {
  const entries = safeExistsSync(ACTUATOR_DIR) ? safeReaddir(ACTUATOR_DIR) : [];
  const manifests: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(ACTUATOR_DIR, entry);
    if (!safeStat(entryPath).isDirectory()) continue;
    const manifestPath = path.join(entryPath, 'manifest.json');
    if (safeExistsSync(manifestPath)) manifests.push(manifestPath);
  }
  return manifests.sort();
}

function readManifest(p: string): Manifest {
  return readSafeJsonFile<Manifest>(p, `actuator manifest ${p}`);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalize(v)).join(',') + '}';
}

function fingerprint(manifest: Manifest): ActuatorFingerprint {
  const ops = manifest.capabilities.map((c) => c.op).sort();
  let contractSchema: string | null = null;
  let contractSchemaSha: string | null = null;
  if (manifest.contract_schema) {
    const schemaPath = pathResolver.rootResolve(manifest.contract_schema);
    if (safeExistsSync(schemaPath)) {
      let parsed: unknown;
      try {
        parsed = readJson<unknown>(schemaPath);
      } catch {
        parsed = readTextFile(schemaPath);
      }
      contractSchemaSha = sha256(canonicalize(parsed));
      contractSchema = manifest.contract_schema;
    } else {
      contractSchema = manifest.contract_schema; // referenced but missing
      contractSchemaSha = null;
    }
  }
  return {
    actuator_id: manifest.actuator_id,
    version: manifest.version,
    ops,
    contract_schema: contractSchema,
    contract_schema_sha256: contractSchemaSha,
  };
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function classifyBump(prev: ActuatorFingerprint, next: ActuatorFingerprint): BumpKind {
  const reasons: string[] = [];
  let level: BumpKind['level'] = 'none';

  const prevOps = new Set(prev.ops);
  const nextOps = new Set(next.ops);
  const removedOps = [...prevOps].filter((o) => !nextOps.has(o));
  const addedOps = [...nextOps].filter((o) => !prevOps.has(o));

  if (removedOps.length > 0) {
    level = 'major';
    reasons.push(`removed ops: ${removedOps.join(', ')}`);
  }
  if (addedOps.length > 0) {
    if (level === 'none') level = 'minor';
    reasons.push(`added ops: ${addedOps.join(', ')}`);
  }
  if (prev.contract_schema_sha256 !== next.contract_schema_sha256) {
    if (level === 'none') level = 'minor';
    reasons.push('contract schema changed');
  }
  if (prev.contract_schema !== next.contract_schema) {
    if (level === 'none') level = 'minor';
    reasons.push(`contract schema path changed: ${prev.contract_schema} → ${next.contract_schema}`);
  }
  return { level, reasons };
}

function bumpSatisfies(prev: string, next: string, required: BumpKind['level']): boolean {
  if (required === 'none') return true;
  const pp = parseSemver(prev);
  const pn = parseSemver(next);
  if (!pp || !pn) return prev !== next; // non-semver: accept any string change
  if (required === 'major') return pn[0] > pp[0];
  if (required === 'minor') return pn[0] > pp[0] || pn[1] > pp[1];
  if (required === 'patch') return compareSemver(prev, next) < 0;
  return true;
}

interface Diagnostic {
  severity: 'error' | 'warning';
  actuator_id: string;
  message: string;
}

function check(prev: BaselineFile, current: ActuatorFingerprint[]): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const prevById = new Map(prev.actuators.map((a) => [a.actuator_id, a]));
  const currById = new Map(current.map((a) => [a.actuator_id, a]));

  for (const [id, currA] of currById) {
    const prevA = prevById.get(id);
    if (!prevA) {
      diags.push({
        severity: 'warning',
        actuator_id: id,
        message: `new actuator detected at version ${currA.version}. Run with --rebaseline to record.`,
      });
      continue;
    }
    const fingerprintEqual =
      JSON.stringify({ ops: prevA.ops, schema: prevA.contract_schema_sha256 }) ===
      JSON.stringify({ ops: currA.ops, schema: currA.contract_schema_sha256 });
    if (fingerprintEqual) continue;

    const bump = classifyBump(prevA, currA);
    const ok = bumpSatisfies(prevA.version, currA.version, bump.level);
    if (!ok) {
      diags.push({
        severity: 'error',
        actuator_id: id,
        message:
          `${id}: surface changed but version not bumped enough. ` +
          `Required bump: ${bump.level}. Reasons: ${bump.reasons.join('; ')}. ` +
          `Baseline: ${prevA.version}, current: ${currA.version}. ` +
          `Bump version in manifest.json then run --rebaseline.`,
      });
    }
  }

  for (const [id, prevA] of prevById) {
    if (!currById.has(id)) {
      diags.push({
        severity: 'error',
        actuator_id: id,
        message:
          `${id} removed (was version ${prevA.version}). ` +
          `Removal requires major bump of the repo + deprecation note. ` +
          `If intentional, run --rebaseline after recording deprecation.`,
      });
    }
  }

  return diags;
}

function loadBaseline(): BaselineFile | null {
  if (!safeExistsSync(BASELINE_PATH)) return null;
  return readSafeJsonFile<BaselineFile>(BASELINE_PATH, 'contract semver baseline');
}

function writeBaseline(file: BaselineFile): void {
  withExecutionContext('ecosystem_architect', () => {
    safeWriteFile(BASELINE_PATH, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8' });
  });
}

function buildBaseline(actuators: ActuatorFingerprint[]): BaselineFile {
  return {
    generated_at: nowIso(),
    generator_note:
      'Baseline of actuator extension-point surfaces for semver enforcement. ' +
      'See docs/developer/EXTENSION_POINTS.md. Update via `pnpm check:contract-semver -- --rebaseline`.',
    actuators: [...actuators].sort((a, b) => a.actuator_id.localeCompare(b.actuator_id)),
  };
}

function printUsage(): string {
  return 'Usage: pnpm check:contract-semver [--rebaseline]';
}

export const runCheckContractSemver = defineScript({
  name: 'check:contract-semver',
  flags: [],
  run(context) {
    const args = context.argv;
    const rebaseline = args.includes('--rebaseline');
    if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
      context.print(printUsage());
      return { help: true };
    }

    const manifests = listActuatorManifests()
      .map(readManifest)
      .filter((m) => m.actuator_id && m.version);
    const fingerprints = manifests.map(fingerprint);

    if (rebaseline) {
      const baseline = buildBaseline(fingerprints);
      writeBaseline(baseline);
      context.print(`✅ Baseline updated: ${BASELINE_PATH}`);
      context.print(`   Recorded ${baseline.actuators.length} actuators.`);
      return { baseline, rebaseline: true };
    }

    const baseline = loadBaseline();
    if (!baseline) {
      const initial = buildBaseline(fingerprints);
      writeBaseline(initial);
      context.print(`📝 No baseline existed. Created initial baseline: ${BASELINE_PATH}`);
      context.print(`   Recorded ${initial.actuators.length} actuators. Commit this file.`);
      return { baseline: initial, rebaseline: false };
    }

    const diags = check(baseline, fingerprints);
    const errors = diags.filter((d) => d.severity === 'error');
    const warnings = diags.filter((d) => d.severity === 'warning');

    for (const w of warnings) context.print(`⚠️  ${w.message}`);

    if (errors.length > 0) {
      throw new ScriptExitError(
        1,
        [
          ...errors.map((error) => `❌ ${error.message}`),
          '',
          `${errors.length} contract-semver violations.`,
        ].join('\n')
      );
    }
    context.print(
      `✅ Contract-semver check passed. ${fingerprints.length} actuators, ${warnings.length} warnings.`
    );
    return { fingerprints, warnings, errors };
  },
});

if (
  isDirectScript(import.meta.url, 'check_contract_semver.ts') ||
  isDirectScript(import.meta.url, 'check_contract_semver.js')
)
  void runCheckContractSemver();
