import { createStandardYargs } from '@agent/core/cli-utils';
import {
  logger,
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
  safeExec,
  loadSurfaceManifest,
  loadSurfaceState,
} from '@agent/core';

const PID_FILE = pathResolver.shared('services-pids.json');

type ServiceLifecycleOperation = 'list' | 'start' | 'stop';
type SurfaceStartableChoice = {
  service_name: string;
  surface_id: string;
  description?: string;
  kind?: string;
  startup_mode?: string;
  service_id?: string;
};

function isRunningPid(pid: unknown): pid is number {
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadPidMap(): Record<string, number> {
  if (!safeExistsSync(PID_FILE)) return {};
  try {
    const parsed = JSON.parse(safeReadFile(PID_FILE, { encoding: 'utf8' }) as string) as Record<
      string,
      unknown
    >;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, pid]) => isRunningPid(pid))
        .map(([serviceName, pid]) => [serviceName, pid as number]),
    );
  } catch {
    return {};
  }
}

function savePidMap(pids: Record<string, number>): void {
  safeWriteFile(PID_FILE, JSON.stringify(pids, null, 2));
}

function loadStartableChoices(): SurfaceStartableChoice[] {
  try {
    const manifest = loadSurfaceManifest();
    const state = loadSurfaceState();
    const runningSurfaceIds = new Set(
      Object.entries(state.surfaces || {})
        .filter(([, record]) => isRunningPid((record as { pid?: unknown }).pid))
        .map(([surfaceId]) => surfaceId),
    );
    return (manifest.surfaces || [])
      .filter((entry: any) => entry && entry.enabled !== false)
      .map((entry: any) => ({
        service_name: String(entry.id || '').trim(),
        surface_id: String(entry.id || '').trim(),
        description: typeof entry.description === 'string' ? entry.description : undefined,
        kind: typeof entry.kind === 'string' ? entry.kind : undefined,
        startup_mode: typeof entry.startupMode === 'string' ? entry.startupMode : undefined,
        service_id: typeof entry.service_id === 'string' ? entry.service_id : undefined,
      }))
      .filter(
        (choice: SurfaceStartableChoice) =>
          choice.service_name &&
          choice.startup_mode === 'background' &&
          !runningSurfaceIds.has(choice.surface_id),
      )
      .sort((left, right) => left.service_name.localeCompare(right.service_name));
  } catch {
    return [];
  }
}

function resolveSurfaceId(serviceName: string): string | undefined {
  const normalized = serviceName.trim();
  if (!normalized) return undefined;
  try {
    const manifest = loadSurfaceManifest();
    for (const entry of manifest.surfaces || []) {
      if (!entry || entry.enabled === false) continue;
      const surfaceId = String((entry as any).id || '').trim();
      const alias = String((entry as any).service_id || '').trim();
      if (surfaceId === normalized || alias === normalized) {
        return surfaceId;
      }
    }
  } catch {
    // fall through to raw service name
  }
  return normalized;
}

function listRunningServices() {
  const pids = loadPidMap();
  return Object.entries(pids)
    .map(([service_name, pid]) => ({ service_name, pid }))
    .sort((left, right) => left.service_name.localeCompare(right.service_name));
}

function listStartableServices() {
  return loadStartableChoices();
}

function stopService(serviceName: string) {
  const pids = loadPidMap();
  const pid = pids[serviceName];
  if (!pid) {
    return {
      status: 'not_found',
      service_name: serviceName,
      running_services: listRunningServices(),
      message: `Service "${serviceName}" is not currently running.`,
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error: any) {
    return {
      status: 'failed',
      service_name: serviceName,
      pid,
      message: error?.message || String(error),
      running_services: listRunningServices(),
    };
  }

  delete pids[serviceName];
  savePidMap(pids);

  return {
    status: 'stopped',
    service_name: serviceName,
    pid,
    running_services: listRunningServices(),
  };
}

function startService(serviceName: string) {
  const surfaceId = resolveSurfaceId(serviceName);
  if (!surfaceId) {
    return {
      status: 'not_found',
      service_name: serviceName,
      startable_services: listStartableServices(),
      message: `Service "${serviceName}" is not declared in the surface manifest.`,
    };
  }

  try {
    const resultText = safeExec(
      'node',
      ['dist/scripts/surface_runtime.js', '--action', 'start', '--surface', surfaceId],
      {
        cwd: pathResolver.rootDir(),
      }
    );

    let parsed: unknown = resultText;
    try {
      parsed = JSON.parse(resultText);
    } catch {
      // keep plain text
    }

    return {
      status: 'started',
      service_name: serviceName,
      surface_id: surfaceId,
      startable_services: listStartableServices(),
      result: parsed,
    };
  } catch (error: any) {
    return {
      status: 'failed',
      service_name: serviceName,
      surface_id: surfaceId,
      startable_services: listStartableServices(),
      message: error?.message || String(error),
    };
  }
}

async function main() {
  const argv = await createStandardYargs()
    .option('operation', {
      type: 'string',
      choices: ['list', 'start', 'stop'] as const,
      default: 'list',
      describe: 'List running services or start/stop a selected service.',
    })
    .option('service-name', {
      alias: 's',
      type: 'string',
      describe: 'Target service name for start/stop operations.',
    })
    .help()
    .parseAsync();

  const operation = argv.operation as ServiceLifecycleOperation;
  const serviceName = String(argv.serviceName || '').trim();

  if (operation === 'start') {
    if (!serviceName) {
      console.log(
        JSON.stringify(
          {
            status: 'selection_required',
            message: 'Select a startable service name and run again with --service-name.',
            startable_services: listStartableServices(),
          },
          null,
          2,
        ),
      );
      return;
    }

    const result = startService(serviceName);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (operation === 'stop') {
    if (!serviceName) {
      console.log(
        JSON.stringify(
          {
            status: 'needs_selection',
            message: 'Select a running service name and run again with --service-name.',
            running_services: listRunningServices(),
          },
          null,
          2,
        ),
      );
      return;
    }

    const result = stopService(serviceName);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = {
    status: 'selection_required',
    running_services: listRunningServices(),
    message: 'Choose a running service name and rerun with --operation stop --service-name <name>.',
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: any) => {
  logger.error(error?.message || String(error));
  process.exit(1);
});
