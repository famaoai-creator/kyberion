/**
 * libs/core/daemon/specs.ts — which daemons get OS-level persistence.
 *
 * Only daemons that record a heartbeat (daemon_watchdog's DEFAULT_DAEMONS)
 * belong here as resident services — anything else cannot be observed when it
 * stops. `daemon-watchdog` runs as a periodic one-shot (startIntervalSec): it
 * must fire even when every watched daemon is dead, which a chronos-scheduled
 * pipeline can never guarantee. `agent-runtime-supervisor` uses
 * keepAliveOnCrashOnly: it exits cleanly when a client-spawned instance holds
 * the daemon lock, and an always-restart policy would respawn-loop against
 * that lock.
 */
import type { DaemonServiceSpec } from './service-manager.js';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { safeRealpath } from '../secure-io.js';

export interface DaemonInstance {
  id: string;
  /** Physical checkout root; path aliases must resolve to the same instance. */
  repoRoot: string;
}

/** Pure identity derivation after the caller has resolved filesystem aliases. */
export function daemonInstanceFromCanonicalRoot(
  canonicalRoot: string,
  platform: NodeJS.Platform = process.platform
): DaemonInstance {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(canonicalRoot) || /[\u0000-\u001f\u007f]/.test(canonicalRoot))
    throw new Error(
      '[DAEMON_INSTANCE_ROOT_INVALID] An absolute canonical checkout root is required'
    );
  const normalized = paths.normalize(canonicalRoot);
  let root = normalized;
  if (normalized !== paths.parse(normalized).root) {
    let end = normalized.length;
    while (end > 0 && (normalized[end - 1] === '/' || normalized[end - 1] === '\\')) end--;
    root = normalized.slice(0, end);
  }
  // Native realpath handles case-insensitive aliases. Directory spelling may
  // still distinguish case-sensitive Windows/WSL trees; only drive letters fold.
  const identityRoot =
    platform === 'win32' ? root.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : root;
  return {
    id: `ws-${createHash('sha256').update(identityRoot).digest('hex').slice(0, 16)}`,
    repoRoot: root,
  };
}

export function resolveDaemonInstance(
  repoRoot: string,
  canonicalize: (root: string) => string = safeRealpath,
  platform: NodeJS.Platform = process.platform
): DaemonInstance {
  return daemonInstanceFromCanonicalRoot(canonicalize(repoRoot), platform);
}

/** All OS management verbs use this same identity, never a global fallback. */
export function scopeDaemonServiceSpec(
  base: DaemonServiceSpec,
  instance: DaemonInstance
): DaemonServiceSpec {
  if (!/^ws-[a-f0-9]{16}$/.test(instance.id))
    throw new Error('[DAEMON_INSTANCE_INVALID] Invalid checkout instance id');
  if (!/^[a-z][a-z0-9.-]*$/i.test(base.label))
    throw new Error('[DAEMON_SERVICE_LABEL_INVALID] Scoped services need a portable base label');
  return {
    ...base,
    instanceId: instance.id,
    label: `${base.label}.${instance.id}`,
    logBaseName: `${base.logBaseName}-${instance.id}`,
  };
}

export const CHRONOS_DAEMON_LABEL = 'com.kyberion.chronos';

export const DAEMON_SPECS: Record<string, DaemonServiceSpec> = {
  chronos: {
    id: 'chronos',
    label: CHRONOS_DAEMON_LABEL,
    daemonScript: 'dist/scripts/chronos_daemon.js',
    logBaseName: 'kyberion-chronos',
    verificationHint: 'heartbeat: active/shared/runtime/heartbeats/chronos-daemon.json',
  },
  'generation-schedule': {
    id: 'generation-schedule',
    label: 'com.kyberion.generation-schedule',
    daemonScript: 'dist/scripts/run_generation_schedule_daemon.js',
    logBaseName: 'kyberion-generation-schedule',
    verificationHint: 'heartbeat: active/shared/runtime/heartbeats/generation-schedule-daemon.json',
  },
  'daemon-watchdog': {
    id: 'daemon-watchdog',
    label: 'com.kyberion.daemon-watchdog',
    daemonScript: 'dist/scripts/daemon_watchdog.js',
    logBaseName: 'kyberion-daemon-watchdog',
    verificationHint: 'ops alerts: active/shared/observability/ops-alerts.jsonl',
    startIntervalSec: 300,
  },
  'agent-runtime-supervisor': {
    id: 'agent-runtime-supervisor',
    label: 'com.kyberion.agent-runtime-supervisor',
    daemonScript: 'dist/scripts/agent_runtime_supervisor_daemon.js',
    logBaseName: 'kyberion-agent-runtime-supervisor',
    keepAliveOnCrashOnly: true,
    verificationHint:
      'heartbeat: active/shared/runtime/heartbeats/agent-runtime-supervisor-daemon.json',
  },
};
