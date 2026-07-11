/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * EnvironmentCapability — declarative environment prerequisite.
 *
 * Macro: features (audio bus, browser driver, streaming STT) need
 * out-of-process resources (binaries, virtual audio devices, env
 * vars, OS permissions, credentials). Listing them in a README is
 * not governable. This module captures the same facts as a typed
 * manifest with three operations:
 *
 *   probeManifest(...)       → are the capabilities satisfied here?
 *   bootstrapManifest(...)   → install the missing ones with operator
 *                              approval; emit audit entries.
 *   verifyReady(...)         → cheap readiness check that downstream
 *                              CLIs run before they do real work.
 *
 * The bootstrap step writes a `setup-receipt.json` under the mission
 * evidence directory (or a shared receipt when `mission_id` absent).
 * Downstream commands fail-closed when the receipt is missing or
 * stale; an explicit override flag keeps incident response possible.
 */

import { spawnSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { auditChain } from './audit-chain.js';

/* ------------------------------------------------------------------ *
 * Types                                                              *
 * ------------------------------------------------------------------ */

export type CapabilityKind =
  | 'binary'
  | 'virtual-audio-device'
  | 'env-var'
  | 'npm-package'
  | 'os-permission'
  | 'vendor-credential'
  | 'mission-evidence';

export type CapabilityProbe =
  /** Run a shell command; available iff exit code === 0. */
  | { kind: 'command'; command: string; args?: readonly string[] }
  /** Try to import a Node package. */
  | { kind: 'module'; specifier: string }
  /** Check that a process.env entry is set (and optionally non-empty). */
  | { kind: 'env'; name: string; require_non_empty?: boolean }
  /** Look for a file under the mission evidence dir. */
  | {
      kind: 'mission-evidence';
      filename: string;
      require_field?: { path: string; equals: unknown };
    }
  /** Plug-in: caller-registered probe id. */
  | { kind: 'probe'; probe_id: string };

export interface CapabilityInstall {
  /** When true, the install is gated on explicit operator approval. */
  operator_confirmed: boolean;
  /** Shell command + args to run when approved (operator can preview). */
  command?: string;
  args?: readonly string[];
  /** Free-text instruction when the install is not automatable. */
  instruction?: string;
  docs_url?: string;
  /** When true, re-run the probe after install to confirm success. */
  retry_after_install?: boolean;
}

export interface EnvironmentCapability {
  capability_id: string;
  kind: CapabilityKind;
  description: string;
  required_for: readonly string[];
  applies_to_platforms?: readonly NodeJS.Platform[];
  probe: CapabilityProbe;
  install?: CapabilityInstall;
  /** When true, an unsatisfied capability is a warning, not an error. */
  optional?: boolean;
}

export interface EnvironmentManifest {
  manifest_id: string;
  version: string;
  description?: string;
  capabilities: EnvironmentCapability[];
  /** HMAC-SHA256 over the canonicalized manifest (without this field). */
  signature?: string;
}

export interface CapabilityStatus {
  capability_id: string;
  satisfied: boolean;
  reason?: string;
  /** True when the capability does not apply to this host (e.g. macOS-only on Linux). */
  not_applicable?: boolean;
}

export interface SetupReceipt {
  manifest_id: string;
  manifest_version: string;
  manifest_fingerprint: string;
  host_fingerprint: string;
  generated_at: string;
  expires_at: string;
  host_platform: NodeJS.Platform;
  satisfied: CapabilityStatus[];
  unsatisfied: CapabilityStatus[];
  installs_performed: Array<{
    capability_id: string;
    command?: string;
    audit_event_id?: string;
  }>;
}

export interface ReadinessReport {
  ready: boolean;
  manifest_id: string;
  generated_at: string;
  receipt_expires_at: string | null;
  missing: CapabilityStatus[];
  receipt_age_minutes: number | null;
}

const DEFAULT_RECEIPT_TTL_MINUTES = 60 * 24 * 7;
const _trustedExecutableManifests = new WeakSet<EnvironmentManifest>();

/* ------------------------------------------------------------------ *
 * Probe registry — for `probe.kind === 'probe'` plug-ins so audio
 * bus / browser driver probes can be wired here without core knowing
 * about them at compile time.
 * ------------------------------------------------------------------ */

export type RegisteredProbe = () => Promise<{ available: boolean; reason?: string }>;
const _probeRegistry = new Map<string, RegisteredProbe>();

export function registerEnvironmentCapabilityProbe(probe_id: string, probe: RegisteredProbe): void {
  _probeRegistry.set(probe_id, probe);
}

export function resetEnvironmentCapabilityProbeRegistry(): void {
  _probeRegistry.clear();
}

/* ------------------------------------------------------------------ *
 * Probe execution                                                    *
 * ------------------------------------------------------------------ */

function appliesToHost(cap: EnvironmentCapability): boolean {
  if (!cap.applies_to_platforms || cap.applies_to_platforms.length === 0) return true;
  return cap.applies_to_platforms.includes(process.platform);
}

function stableManifestFingerprint(manifest: EnvironmentManifest): string {
  const normalized = {
    manifest_id: manifest.manifest_id,
    version: manifest.version,
    capabilities: manifest.capabilities.map((cap) => ({
      capability_id: cap.capability_id,
      kind: cap.kind,
      required_for: [...cap.required_for].sort(),
      applies_to_platforms: [...(cap.applies_to_platforms || [])].sort(),
      probe: cap.probe,
      optional: Boolean(cap.optional),
    })),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function stableHostFingerprint(): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
      })
    )
    .digest('hex');
}

function addMinutes(isoTimestamp: string, minutes: number): string {
  return new Date(new Date(isoTimestamp).getTime() + minutes * 60_000).toISOString();
}

function parseIsoDate(value: unknown): { ok: true; ms: number } | { ok: false } {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false };
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? { ok: true, ms } : { ok: false };
}

async function runProbe(
  probe: CapabilityProbe,
  missionId?: string,
  allowExecutableProbe = false
): Promise<{ available: boolean; reason?: string }> {
  switch (probe.kind) {
    case 'command': {
      if (!allowExecutableProbe) {
        return {
          available: false,
          reason:
            'command probe denied: manifest was not loaded from the governed manifest directory',
        };
      }
      const result = spawnSync(probe.command, [...(probe.args ?? [])], { stdio: 'ignore' });
      if (result.error) {
        return { available: false, reason: `${probe.command}: ${result.error.message}` };
      }
      return result.status === 0
        ? { available: true }
        : { available: false, reason: `${probe.command} exited with code ${result.status}` };
    }
    case 'module': {
      if (!allowExecutableProbe) {
        return {
          available: false,
          reason:
            'module probe denied: manifest was not loaded from the governed manifest directory',
        };
      }
      try {
        await import(probe.specifier);
        return { available: true };
      } catch (err: any) {
        return {
          available: false,
          reason: `cannot import '${probe.specifier}': ${err?.message ?? err}`,
        };
      }
    }
    case 'env': {
      const value = process.env[probe.name];
      if (value === undefined) {
        return { available: false, reason: `env var ${probe.name} is unset` };
      }
      if (probe.require_non_empty && value === '') {
        return { available: false, reason: `env var ${probe.name} is empty` };
      }
      return { available: true };
    }
    case 'mission-evidence': {
      if (!missionId)
        return { available: false, reason: 'mission-evidence probe requires a mission id' };
      const evidenceDir = pathResolver.missionEvidenceDir(missionId);
      if (!evidenceDir)
        return { available: false, reason: `mission '${missionId}' has no evidence dir` };
      const file = path.join(evidenceDir, probe.filename);
      if (!safeExistsSync(file)) return { available: false, reason: `${probe.filename} missing` };
      if (!probe.require_field) return { available: true };
      try {
        const data = JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string);
        const value = probe.require_field.path
          .split('.')
          .reduce<any>((acc, key) => (acc != null ? acc[key] : undefined), data);
        if (value !== probe.require_field.equals) {
          return {
            available: false,
            reason: `${probe.filename} ${probe.require_field.path} expected '${String(probe.require_field.equals)}', got '${String(value)}'`,
          };
        }
        return { available: true };
      } catch (err: any) {
        return {
          available: false,
          reason: `failed to read ${probe.filename}: ${err?.message ?? err}`,
        };
      }
    }
    case 'probe': {
      const fn = _probeRegistry.get(probe.probe_id);
      if (!fn)
        return { available: false, reason: `no probe registered for id '${probe.probe_id}'` };
      try {
        return await fn();
      } catch (err: any) {
        return {
          available: false,
          reason: `probe '${probe.probe_id}' threw: ${err?.message ?? err}`,
        };
      }
    }
    default: {
      const exhaustive: never = probe;
      return { available: false, reason: `unknown probe kind: ${JSON.stringify(exhaustive)}` };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Public API                                                          *
 * ------------------------------------------------------------------ */

export async function probeManifest(
  manifest: EnvironmentManifest,
  opts: { mission_id?: string } = {}
): Promise<CapabilityStatus[]> {
  const out: CapabilityStatus[] = [];
  const allowExecutableProbe = _trustedExecutableManifests.has(manifest);
  for (const cap of manifest.capabilities) {
    if (!appliesToHost(cap)) {
      out.push({ capability_id: cap.capability_id, satisfied: true, not_applicable: true });
      continue;
    }
    const result = await runProbe(cap.probe, opts.mission_id, allowExecutableProbe);
    out.push({
      capability_id: cap.capability_id,
      satisfied: result.available,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }
  return out;
}

export interface BootstrapOptions {
  mission_id?: string;
  /** When false, the bootstrap is a dry run — prints what would be
   *  installed but performs no install. */
  apply: boolean;
  /** Operator passed `--apply --force` to bypass the per-capability
   *  approval prompt (still audit-emitted). */
  force_yes?: boolean;
}

export async function bootstrapManifest(
  manifest: EnvironmentManifest,
  opts: BootstrapOptions
): Promise<SetupReceipt> {
  const allowExecutableManifest = _trustedExecutableManifests.has(manifest);
  const probes = await probeManifest(manifest, opts);
  const satisfied: CapabilityStatus[] = [];
  const unsatisfied: CapabilityStatus[] = [];
  const installsPerformed: SetupReceipt['installs_performed'] = [];

  for (const cap of manifest.capabilities) {
    const status = probes.find((p) => p.capability_id === cap.capability_id)!;
    if (status.satisfied) {
      satisfied.push(status);
      continue;
    }
    if (!cap.install) {
      unsatisfied.push({
        ...status,
        reason: `${status.reason ?? 'unsatisfied'} (no install instruction)`,
      });
      continue;
    }
    if (!opts.apply) {
      unsatisfied.push({
        ...status,
        reason: `${status.reason ?? 'unsatisfied'} (dry run; rerun with --apply to install)`,
      });
      continue;
    }
    if (cap.install.operator_confirmed && !opts.force_yes) {
      unsatisfied.push({
        ...status,
        reason: `${status.reason ?? 'unsatisfied'} (operator-confirmed install — preview the command and rerun with --apply --force)`,
      });
      continue;
    }
    if (!cap.install.command) {
      unsatisfied.push({
        ...status,
        reason: `${status.reason ?? 'unsatisfied'} (manual instruction: ${cap.install.instruction ?? 'see docs'})`,
      });
      continue;
    }
    if (!allowExecutableManifest) {
      unsatisfied.push({
        ...status,
        reason: `${status.reason ?? 'unsatisfied'} (install command denied: manifest was not loaded from the governed manifest directory)`,
      });
      continue;
    }
    const installResult = spawnSync(cap.install.command, [...(cap.install.args ?? [])], {
      stdio: 'inherit',
    });
    const auditId = safeEmitAudit('env_bootstrap.install', cap.capability_id, {
      command: cap.install.command,
      args: cap.install.args,
      exit_code: installResult.status ?? -1,
      mission_id: opts.mission_id,
    });
    installsPerformed.push({
      capability_id: cap.capability_id,
      command: cap.install.command,
      ...(auditId ? { audit_event_id: auditId } : {}),
    });
    if (installResult.status !== 0) {
      unsatisfied.push({
        ...status,
        reason: `install command failed with exit code ${installResult.status}`,
      });
      continue;
    }
    if (cap.install.retry_after_install !== false) {
      const recheck = await runProbe(cap.probe, opts.mission_id, allowExecutableManifest);
      if (recheck.available) {
        satisfied.push({ capability_id: cap.capability_id, satisfied: true });
      } else {
        unsatisfied.push({
          capability_id: cap.capability_id,
          satisfied: false,
          reason: `install ran but probe still failing: ${recheck.reason ?? ''}`,
        });
      }
    } else {
      satisfied.push({ capability_id: cap.capability_id, satisfied: true });
    }
  }

  const receipt: SetupReceipt = {
    manifest_id: manifest.manifest_id,
    manifest_version: manifest.version,
    manifest_fingerprint: stableManifestFingerprint(manifest),
    host_fingerprint: stableHostFingerprint(),
    generated_at: new Date().toISOString(),
    expires_at: addMinutes(new Date().toISOString(), DEFAULT_RECEIPT_TTL_MINUTES),
    host_platform: process.platform,
    satisfied,
    unsatisfied,
    installs_performed: installsPerformed,
  };
  for (const status of unsatisfied) {
    safeEmitAudit(
      'env_bootstrap.capability_unsatisfied',
      status.capability_id,
      {
        manifest_id: manifest.manifest_id,
        mission_id: opts.mission_id,
        reason: status.reason,
      },
      'failed',
      status.reason
    );
  }
  // Only persist when something was actually installed (or attempted).
  // A dry-run probe does not produce a receipt — `verifyReady` would
  // otherwise treat a probe-only run as "ready" until next probe.
  if (opts.apply) writeReceipt(receipt, opts.mission_id);
  return receipt;
}

export function verifyReady(
  manifest: EnvironmentManifest,
  opts: { mission_id?: string; max_age_minutes?: number } = {}
): ReadinessReport {
  const receipt = readReceipt(manifest.manifest_id, opts.mission_id);
  if (!receipt) {
    return {
      ready: false,
      manifest_id: manifest.manifest_id,
      generated_at: new Date().toISOString(),
      receipt_expires_at: null,
      missing: manifest.capabilities.map((c) => ({
        capability_id: c.capability_id,
        satisfied: false,
        reason: 'no setup receipt — run pnpm env:bootstrap',
      })),
      receipt_age_minutes: null,
    };
  }
  const satisfiedEntries = Array.isArray(receipt.satisfied) ? receipt.satisfied : null;
  const unsatisfiedEntries = Array.isArray(receipt.unsatisfied) ? receipt.unsatisfied : null;
  const installsPerformedEntries = Array.isArray(receipt.installs_performed)
    ? receipt.installs_performed
    : null;
  const generatedAt = parseIsoDate(receipt.generated_at);
  const expiresAt = parseIsoDate(receipt.expires_at);
  const ageMin = generatedAt.ok ? (Date.now() - generatedAt.ms) / 60_000 : Number.NaN;
  const manifestFingerprint = stableManifestFingerprint(manifest);
  const hostFingerprint = stableHostFingerprint();
  const receiptExpiresAt =
    typeof receipt.expires_at === 'string' && receipt.expires_at.trim() !== ''
      ? receipt.expires_at
      : null;
  const expiresAtMs = expiresAt.ok ? expiresAt.ms : Number.NaN;
  const stale =
    !generatedAt.ok ||
    !expiresAt.ok ||
    (opts.max_age_minutes !== undefined && ageMin > opts.max_age_minutes) ||
    (generatedAt.ok && ageMin < 0) ||
    (expiresAt.ok && Date.now() > expiresAtMs);
  // Optional capabilities never block readiness.
  const blocking = (unsatisfiedEntries ?? []).filter((u) => {
    const cap = manifest.capabilities.find((c) => c.capability_id === u.capability_id);
    return cap && !cap.optional;
  });
  if (!satisfiedEntries) {
    blocking.push({
      capability_id: '__receipt_satisfied__',
      satisfied: false,
      reason: 'receipt satisfied entries are missing or invalid — re-run pnpm env:bootstrap',
    });
  }
  if (!unsatisfiedEntries) {
    blocking.push({
      capability_id: '__receipt_unsatisfied__',
      satisfied: false,
      reason: 'receipt unsatisfied entries are missing or invalid — re-run pnpm env:bootstrap',
    });
  }
  if (!installsPerformedEntries) {
    blocking.push({
      capability_id: '__receipt_installs_performed__',
      satisfied: false,
      reason:
        'receipt installs_performed entries are missing or invalid — re-run pnpm env:bootstrap',
    });
  }
  if (!generatedAt.ok) {
    blocking.push({
      capability_id: '__receipt_generated_at__',
      satisfied: false,
      reason: 'receipt generated_at is missing or invalid — re-run pnpm env:bootstrap',
    });
  }
  if (!expiresAt.ok) {
    blocking.push({
      capability_id: '__receipt_expires_at__',
      satisfied: false,
      reason: 'receipt expires_at is missing or invalid — re-run pnpm env:bootstrap',
    });
  }
  if (receipt.manifest_fingerprint !== manifestFingerprint) {
    blocking.push({
      capability_id: '__manifest_fingerprint__',
      satisfied: false,
      reason: 'receipt fingerprint does not match the current manifest — re-run pnpm env:bootstrap',
    });
  }
  if (receipt.host_fingerprint !== hostFingerprint) {
    blocking.push({
      capability_id: '__host_fingerprint__',
      satisfied: false,
      reason: 'receipt was generated on a different host fingerprint — re-run pnpm env:bootstrap',
    });
  }
  if (stale) {
    blocking.push({
      capability_id: '__receipt_age__',
      satisfied: false,
      reason:
        expiresAt.ok && receiptExpiresAt && Date.now() > expiresAtMs
          ? `receipt expired at ${receiptExpiresAt}`
          : generatedAt.ok
            ? `receipt is ${ageMin.toFixed(1)}m old; max_age_minutes=${opts.max_age_minutes}`
            : 'receipt age could not be computed because generated_at is invalid',
    });
  }
  return {
    ready: blocking.length === 0,
    manifest_id: manifest.manifest_id,
    generated_at: generatedAt.ok ? receipt.generated_at : new Date().toISOString(),
    receipt_expires_at: receiptExpiresAt,
    missing: blocking,
    receipt_age_minutes: generatedAt.ok ? ageMin : null,
  };
}

/* ------------------------------------------------------------------ *
 * Receipt persistence                                                 *
 * ------------------------------------------------------------------ */

function receiptPath(manifestId: string, missionId?: string): string {
  if (missionId) {
    const evidenceDir =
      pathResolver.missionEvidenceDir(missionId) ??
      pathResolver.rootResolve(`active/missions/confidential/${missionId}/evidence`);
    return path.join(evidenceDir, `env-setup-receipt.${manifestId}.json`);
  }
  return pathResolver.rootResolve(`active/shared/state/env-setup-receipts/${manifestId}.json`);
}

function writeReceipt(receipt: SetupReceipt, missionId?: string): void {
  const file = receiptPath(receipt.manifest_id, missionId);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(receipt, null, 2));
}

function readReceipt(manifestId: string, missionId?: string): SetupReceipt | null {
  const file = receiptPath(manifestId, missionId);
  if (!safeExistsSync(file)) return null;
  try {
    return JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string) as SetupReceipt;
  } catch (err: any) {
    logger.warn(`[environment-capability] receipt parse failed: ${err?.message ?? err}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Manifest loading                                                    *
 * ------------------------------------------------------------------ */

const DEFAULT_MANIFEST_DIR = 'knowledge/product/governance/environment-manifests';

function governedManifestDir(): string {
  const dir = pathResolver.rootResolve(DEFAULT_MANIFEST_DIR);
  if (safeExistsSync(dir) && safeLstat(dir).isSymbolicLink()) {
    throw new Error('[environment-capability] governed manifest directory must not be a symlink');
  }
  return dir;
}

function assertNoSymlinkPath(file: string, governedDir: string): void {
  const relative = path.relative(governedDir, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      '[environment-capability] manifest must be inside the governed manifest directory'
    );
  }
  let current = governedDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (safeLstat(current).isSymbolicLink()) {
      throw new Error(
        `[environment-capability] manifest path must not contain symlinks: ${current}`
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Manifest signing (SA-02) — manifests grant command/module execution
 * and install authority, so their integrity is enforceable via
 * HMAC-SHA256. When KYBERION_MANIFEST_SIGNING_KEY is configured, every
 * manifest must carry a valid signature (fail-closed). Without a key,
 * unsigned manifests load with a one-time warning (warn phase).
 * ------------------------------------------------------------------ */

const MANIFEST_SIGNING_KEY_ENV = 'KYBERION_MANIFEST_SIGNING_KEY';
const warnedUnsignedManifests = new Set<string>();

function canonicalizeForSigning(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeForSigning).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, entryValue]) => key !== 'signature' && entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalizeForSigning(entryValue)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeManifestSignature(
  manifest: Omit<EnvironmentManifest, 'signature'> & { signature?: string },
  signingKey: string
): string {
  return createHmac('sha256', signingKey).update(canonicalizeForSigning(manifest)).digest('hex');
}

export function verifyManifestSignature(
  manifest: EnvironmentManifest,
  signingKey: string
): boolean {
  const provided = String(manifest.signature || '');
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = computeManifestSignature(manifest, signingKey);
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

function enforceManifestSignature(manifest: EnvironmentManifest): void {
  const signingKey = process.env[MANIFEST_SIGNING_KEY_ENV];
  if (signingKey) {
    if (!verifyManifestSignature(manifest, signingKey)) {
      throw new Error(
        `[environment-capability] manifest '${manifest.manifest_id}' has a missing or invalid ` +
          'signature — re-sign with pnpm manifests:sign or remove the tampered file'
      );
    }
    return;
  }
  if (!manifest.signature && !warnedUnsignedManifests.has(manifest.manifest_id)) {
    warnedUnsignedManifests.add(manifest.manifest_id);
    logger.warn(
      `[environment-capability] manifest '${manifest.manifest_id}' is unsigned and no ` +
        `${MANIFEST_SIGNING_KEY_ENV} is configured (warn phase — set the key and run ` +
        'pnpm manifests:sign to enforce signatures)'
    );
  }
}

function parseEnvironmentManifest(raw: string, expectedId: string): EnvironmentManifest {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[environment-capability] manifest must be a JSON object');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.manifest_id !== expectedId || typeof candidate.version !== 'string') {
    throw new Error('[environment-capability] manifest id/version is invalid');
  }
  if (!Array.isArray(candidate.capabilities)) {
    throw new Error('[environment-capability] manifest capabilities must be an array');
  }
  for (const [index, capability] of candidate.capabilities.entries()) {
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
      throw new Error(`[environment-capability] capability ${index} must be an object`);
    }
    const cap = capability as Record<string, unknown>;
    if (
      typeof cap.capability_id !== 'string' ||
      typeof cap.kind !== 'string' ||
      typeof cap.description !== 'string' ||
      !Array.isArray(cap.required_for) ||
      !cap.required_for.every((item) => typeof item === 'string') ||
      !cap.probe ||
      typeof cap.probe !== 'object' ||
      Array.isArray(cap.probe)
    ) {
      throw new Error(`[environment-capability] capability ${index} has an invalid schema`);
    }
    const probe = cap.probe as Record<string, unknown>;
    if (!['command', 'module', 'env', 'mission-evidence', 'probe'].includes(String(probe.kind))) {
      throw new Error(`[environment-capability] capability ${index} has an invalid probe kind`);
    }
    if (probe.kind === 'command' && typeof probe.command !== 'string') {
      throw new Error(`[environment-capability] capability ${index} command probe is invalid`);
    }
    if (probe.kind === 'module' && typeof probe.specifier !== 'string') {
      throw new Error(`[environment-capability] capability ${index} module probe is invalid`);
    }
  }
  return value as EnvironmentManifest;
}

/**
 * Enumerate the manifest ids present under the canonical manifest
 * directory. The bootstrap CLI uses this for `--list` and `--all`.
 */
export function listEnvironmentManifestIds(): string[] {
  const dir = governedManifestDir();
  if (!safeExistsSync(dir)) return [];
  const ids: string[] = [];
  try {
    for (const entry of safeReaddir(dir)) {
      if (entry.endsWith('.json')) ids.push(entry.slice(0, -'.json'.length));
    }
  } catch (err: any) {
    logger.warn(`[environment-capability] listEnvironmentManifestIds: ${err?.message ?? err}`);
  }
  return ids.sort();
}

export function loadEnvironmentManifest(manifestIdOrPath: string): EnvironmentManifest {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifestIdOrPath)) {
    throw new Error('[environment-capability] manifest must be referenced by id, not by path');
  }
  const manifestId = manifestIdOrPath.endsWith('.json')
    ? manifestIdOrPath.slice(0, -'.json'.length)
    : manifestIdOrPath;
  const dir = governedManifestDir();
  const abs = path.join(dir, `${manifestId}.json`);
  if (safeExistsSync(abs)) {
    assertNoSymlinkPath(abs, dir);
    const manifest = parseEnvironmentManifest(
      safeReadFile(abs, { encoding: 'utf8' }) as string,
      manifestId
    );
    enforceManifestSignature(manifest);
    _trustedExecutableManifests.add(manifest);
    return manifest;
  }
  throw new Error(`[environment-capability] manifest not found: ${manifestIdOrPath}`);
}

/* ------------------------------------------------------------------ *
 * Internal helpers                                                    *
 * ------------------------------------------------------------------ */

function safeEmitAudit(
  action: string,
  capabilityId: string,
  metadata: Record<string, unknown>,
  result: 'allowed' | 'denied' | 'error' | 'completed' | 'failed' = 'allowed',
  reason?: string
): string | null {
  try {
    const entry = auditChain.record({
      agentId: 'env-bootstrap',
      action,
      operation: capabilityId,
      result,
      ...(reason ? { reason } : {}),
      metadata,
    });
    return entry.id;
  } catch (err: any) {
    logger.warn(`[environment-capability] audit emission failed: ${err?.message ?? err}`);
    return null;
  }
}
