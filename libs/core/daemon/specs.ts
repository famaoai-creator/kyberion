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
