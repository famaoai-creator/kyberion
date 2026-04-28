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
import * as path from 'node:path';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import {
  safeExistsSync,
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
  | { kind: 'mission-evidence'; filename: string; require_field?: { path: string; equals: unknown } }
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
  generated_at: string;
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
  missing: CapabilityStatus[];
  receipt_age_minutes: number | null;
}

/* ------------------------------------------------------------------ *
 * Probe registry — for `probe.kind === 'probe'` plug-ins so audio
 * bus / browser driver probes can be wired here without core knowing
 * about them at compile time.
 * ------------------------------------------------------------------ */

export type RegisteredProbe = () => Promise<{ available: boolean; reason?: string }>;
const _probeRegistry = new Map<string, RegisteredProbe>();

export function registerEnvironmentCapabilityProbe(
  probe_id: string,
  probe: RegisteredProbe,
): void {
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

async function runProbe(probe: CapabilityProbe, missionId?: string): Promise<{ available: boolean; reason?: string }> {
  switch (probe.kind) {
    case 'command': {
      const result = spawnSync(probe.command, [...(probe.args ?? [])], { stdio: 'ignore' });
      if (result.error) {
        return { available: false, reason: `${probe.command}: ${result.error.message}` };
      }
      return result.status === 0
        ? { available: true }
        : { available: false, reason: `${probe.command} exited with code ${result.status}` };
    }
    case 'module': {
      try {
        await import(probe.specifier);
        return { available: true };
      } catch (err: any) {
        return { available: false, reason: `cannot import '${probe.specifier}': ${err?.message ?? err}` };
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
      if (!missionId) return { available: false, reason: 'mission-evidence probe requires a mission id' };
      const evidenceDir = pathResolver.missionEvidenceDir(missionId);
      if (!evidenceDir) return { available: false, reason: `mission '${missionId}' has no evidence dir` };
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
        return { available: false, reason: `failed to read ${probe.filename}: ${err?.message ?? err}` };
      }
    }
    case 'probe': {
      const fn = _probeRegistry.get(probe.probe_id);
      if (!fn) return { available: false, reason: `no probe registered for id '${probe.probe_id}'` };
      try {
        return await fn();
      } catch (err: any) {
        return { available: false, reason: `probe '${probe.probe_id}' threw: ${err?.message ?? err}` };
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
  opts: { mission_id?: string } = {},
): Promise<CapabilityStatus[]> {
  const out: CapabilityStatus[] = [];
  for (const cap of manifest.capabilities) {
    if (!appliesToHost(cap)) {
      out.push({ capability_id: cap.capability_id, satisfied: true, not_applicable: true });
      continue;
    }
    const result = await runProbe(cap.probe, opts.mission_id);
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
  opts: BootstrapOptions,
): Promise<SetupReceipt> {
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
    const installResult = spawnSync(cap.install.command, [...(cap.install.args ?? [])], {
      stdio: 'inherit',
    });
    const auditId = safeEmitAudit('env_bootstrap.install', cap.capability_id, {
      command: cap.install.command,
      args: cap.install.args,
      exit_code: installResult.status ?? -1,
      tenant_slug: opts.mission_id,
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
      const recheck = await runProbe(cap.probe, opts.mission_id);
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
    generated_at: new Date().toISOString(),
    host_platform: process.platform,
    satisfied,
    unsatisfied,
    installs_performed: installsPerformed,
  };
  // Only persist when something was actually installed (or attempted).
  // A dry-run probe does not produce a receipt — `verifyReady` would
  // otherwise treat a probe-only run as "ready" until next probe.
  if (opts.apply) writeReceipt(receipt, opts.mission_id);
  return receipt;
}

export function verifyReady(
  manifest: EnvironmentManifest,
  opts: { mission_id?: string; max_age_minutes?: number } = {},
): ReadinessReport {
  const receipt = readReceipt(manifest.manifest_id, opts.mission_id);
  if (!receipt) {
    return {
      ready: false,
      manifest_id: manifest.manifest_id,
      generated_at: new Date().toISOString(),
      missing: manifest.capabilities.map((c) => ({
        capability_id: c.capability_id,
        satisfied: false,
        reason: 'no setup receipt — run pnpm env:bootstrap',
      })),
      receipt_age_minutes: null,
    };
  }
  const ageMs = Date.now() - new Date(receipt.generated_at).getTime();
  const ageMin = ageMs / 60_000;
  const stale = opts.max_age_minutes !== undefined && ageMin > opts.max_age_minutes;
  // Optional capabilities never block readiness.
  const blocking = receipt.unsatisfied.filter((u) => {
    const cap = manifest.capabilities.find((c) => c.capability_id === u.capability_id);
    return cap && !cap.optional;
  });
  return {
    ready: blocking.length === 0 && !stale,
    manifest_id: manifest.manifest_id,
    generated_at: receipt.generated_at,
    missing: stale
      ? [
          ...blocking,
          {
            capability_id: '__receipt_age__',
            satisfied: false,
            reason: `receipt is ${ageMin.toFixed(1)}m old; max_age_minutes=${opts.max_age_minutes}`,
          },
        ]
      : blocking,
    receipt_age_minutes: ageMin,
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
  return pathResolver.rootResolve(
    `active/shared/state/env-setup-receipts/${manifestId}.json`,
  );
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

const DEFAULT_MANIFEST_DIR = 'knowledge/public/governance/environment-manifests';

/**
 * Enumerate the manifest ids present under the canonical manifest
 * directory. The bootstrap CLI uses this for `--list` and `--all`.
 */
export function listEnvironmentManifestIds(): string[] {
  const dir = pathResolver.rootResolve(
    process.env.KYBERION_ENVIRONMENT_MANIFEST_DIR ?? DEFAULT_MANIFEST_DIR,
  );
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
  const candidates = manifestIdOrPath.endsWith('.json')
    ? [manifestIdOrPath]
    : [
        path.join(
          process.env.KYBERION_ENVIRONMENT_MANIFEST_DIR ?? DEFAULT_MANIFEST_DIR,
          `${manifestIdOrPath}.json`,
        ),
        path.join(DEFAULT_MANIFEST_DIR, `${manifestIdOrPath}.json`),
      ];
  for (const rel of candidates) {
    const abs = pathResolver.rootResolve(rel);
    if (!safeExistsSync(abs)) continue;
    return JSON.parse(safeReadFile(abs, { encoding: 'utf8' }) as string) as EnvironmentManifest;
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
): string | null {
  try {
    const entry = auditChain.record({
      agentId: 'env-bootstrap',
      action,
      operation: capabilityId,
      result: 'allowed',
      metadata,
    });
    return entry.id;
  } catch (err: any) {
    logger.warn(`[environment-capability] audit emission failed: ${err?.message ?? err}`);
    return null;
  }
}
