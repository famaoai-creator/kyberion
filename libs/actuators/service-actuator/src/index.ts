import { logger, safeExec, safeReadFile, safeWriteFile, safeAppendFile, safeExistsSync, safeMkdir, safeOpenAppendFile, withRetry, runtimeSupervisor, spawnManagedProcess, stopManagedProcess, derivePipelineStatus, resolveServiceBinding } from '@agent/core';
import { secureFetch } from '@agent/core/network';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Service-Actuator v1.1.0 [STREAMING SUPPORTED]
 * Unified Reachability Layer for External SaaS/APIs.
 * Enforces Service-Aware Secret Injection (Least Privilege).
 */
const ALLOW_UNSAFE_CLI = process.env.KYBERION_ALLOW_UNSAFE_CLI === 'true';

function assertUnsafeCliAllowed() {
  if (!ALLOW_UNSAFE_CLI) {
    throw new Error('[SECURITY] CLI execution disabled. Set KYBERION_ALLOW_UNSAFE_CLI=true to enable.');
  }
}

interface ServiceAction {
  service_id: string; // e.g., 'slack', 'jira', 'box'
  mode: 'API' | 'CLI' | 'SDK' | 'STREAM' | 'RECONCILE';
  action: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params: any;
  auth?: 'none' | 'secret-guard' | 'session';
}

const PID_FILE = path.join(process.cwd(), 'active/shared/services-pids.json');
const STIMULI_PATH = path.join(process.cwd(), 'presence/bridge/runtime/stimuli.jsonl');

function serviceResourceId(serviceId: string): string {
  return `service:${serviceId}`;
}

function loadPids() {
  if (!safeExistsSync(PID_FILE)) return {};
  try {
    const content = safeReadFile(PID_FILE, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  } catch (_) { return {}; }
}

function savePids(pids: any) {
  safeWriteFile(PID_FILE, JSON.stringify(pids, null, 2));
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) { return false; }
}

function emitRecoveryStimulus(serviceId: string) {
  const date = new Date();
  const stimulus = {
    id: `req-${date.toISOString().split('T')[0].replace(/-/g, '')}-recovery-${crypto.randomBytes(3).toString('hex')}`,
    ts: date.toISOString(),
    ttl: 600,
    origin: { channel: 'system', source_id: 'service-actuator' },
    signal: { intent: 'alert', priority: 8, payload: `[SELF_HEALING] Service '${serviceId}' crash detected.` },
    control: { status: 'pending', feedback: 'auto', evidence: [{ step: 'auto_recovery', ts: date.toISOString(), agent: 'service-actuator' }] }
  };
  safeAppendFile(STIMULI_PATH, JSON.stringify(stimulus) + "\n");
}

function registerServiceRuntime(serviceId: string, pid: number | undefined, manifestPath?: string) {
  if (!pid) return;

  const updated = runtimeSupervisor.update(serviceResourceId(serviceId), {
    pid,
    state: 'running',
    metadata: {
      serviceId,
      manifestPath,
    },
    lastActiveAt: Date.now(),
  });

  if (!updated) {
    runtimeSupervisor.register({
      resourceId: serviceResourceId(serviceId),
      kind: 'service',
      ownerId: manifestPath || serviceId,
      ownerType: manifestPath ? 'service-manifest' : 'service',
      pid,
      shutdownPolicy: 'detached',
      metadata: {
        serviceId,
        manifestPath,
      },
      cleanup: () => {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (_) {}
      },
    });
  }
}

function unregisterServiceRuntime(serviceId: string) {
  runtimeSupervisor.unregister(serviceResourceId(serviceId));
}

async function startService(id: string, service: any, pids: any) {
  const rootDir = process.cwd();
  const scriptPath = path.join(rootDir, service.path);
  const logFile = path.join(rootDir, `active/shared/logs/${id}.log`);
  if (!safeExistsSync(path.dirname(logFile))) safeMkdir(path.dirname(logFile), { recursive: true });
  const out = safeOpenAppendFile(logFile);
  
  const env = { ...process.env, ...(service.env || {}) };
  const managed = spawnManagedProcess({
    resourceId: serviceResourceId(id),
    kind: 'service',
    ownerId: service.path || id,
    ownerType: 'service-actuator',
    command: 'npx',
    args: ['tsx', scriptPath],
    shutdownPolicy: 'detached',
    spawnOptions: {
      detached: true,
      stdio: ['ignore', out, out],
      cwd: rootDir,
      env,
    },
    metadata: {
      scriptPath,
    },
  });
  const child = managed.child;
  child.unref();
  pids[id] = child.pid;
  registerServiceRuntime(id, child.pid, scriptPath);
  logger.success(`  - ${id} started (PID: ${child.pid}).`);
}

async function handleAction(input: any, onEvent?: (data: any) => void) {
  if (input.action === 'pipeline') {
    const results = [];
    let ctx = { ...input.context };
    for (const step of input.steps) {
      logger.info(`🔌 [SERVICE] Executing step: ${step.op}`);
      const stepResult = await withRetry(async () => {
        return await handleSingleAction({
          service_id: step.params.service_id,
          mode: step.op.toUpperCase() as any,
          action: step.params.action,
          params: step.params.params,
          auth: step.params.auth,
          method: step.params.method
        });
      }, step.params.retry || { maxRetries: 2 });
      
      const exportKey = step.params.export_as || 'last_service_result';
      ctx[exportKey] = stepResult;
      results.push({ op: step.op, status: 'success' });
    }
    if (input.context?.context_path) {
      safeWriteFile(path.resolve(process.cwd(), input.context.context_path), JSON.stringify(ctx, null, 2));
    }
    return { status: derivePipelineStatus(results), results, ...ctx };
  }
  return await handleSingleAction(input, onEvent);
}

async function handleSingleAction(input: ServiceAction, onEvent?: (data: any) => void) {
  logger.info(`🔌 [SERVICE] Dispatching to ${input.service_id} (Mode: ${input.mode}, Action: ${input.action})`);

  // 1. Service-Aware Guard: Only allow access to requested service's secrets
  let binding = input.auth ? resolveServiceBinding(input.service_id, input.auth) : resolveServiceBinding(input.service_id, 'none');
  let token: string | null = binding.accessToken || null;
  if (input.auth === 'secret-guard') {
    if (!token && input.mode !== 'STREAM') {
      throw new Error(`Access Denied: No access token found for service "${input.service_id}"`);
    }
    logger.info(`🔐 [AUTH] Bound authenticated service access for ${input.service_id}`);
  }

  // 2. Multi-Mode Execution
  switch (input.mode) {
    case 'RECONCILE':
      const manifestPath = path.resolve(process.cwd(), input.params.manifest_path);
      const manifest = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string);
      const pids = loadPids();
      let changed = false;

      // Drop stale PIDs from the persisted registry before reconcile
      for (const [id, pid] of Object.entries(pids)) {
        if (!isRunning(pid as number)) {
          unregisterServiceRuntime(id);
          delete pids[id];
          changed = true;
        } else {
          registerServiceRuntime(id, pid as number, manifestPath);
        }
      }

      // Start missing or crashed services
      for (const [id, service] of Object.entries(manifest)) {
        if (!pids[id] || !isRunning(pids[id])) {
          await startService(id, service, pids);
          if (pids[id]) emitRecoveryStimulus(id);
          changed = true;
        } else {
          registerServiceRuntime(id, pids[id], manifestPath);
        }
      }

      // Optional: Cleanup services not in manifest
      if (input.params.cleanup) {
        for (const [id, pid] of Object.entries(pids)) {
          if (!manifest[id]) {
            if (isRunning(pid as number)) {
              try { process.kill(pid as number, 'SIGTERM'); } catch (_) {}
              logger.info(`  - ${id} stopped (not in manifest).`);
            }
            stopManagedProcess(serviceResourceId(id), null);
            unregisterServiceRuntime(id);
            delete pids[id];
            changed = true;
          }
        }
      }

      if (changed) savePids(pids);
      return { status: 'reconciled', active_services: Object.keys(pids) };

    case 'STREAM':
      if (input.service_id === 'slack') {
        throw new Error('Slack streaming ingress belongs to the Slack gateway (satellites/slack-bridge), not service-actuator.');
      }
      throw new Error(`Streaming not implemented for ${input.service_id}`);

    case 'API':
      let baseUrl: string;
      if (input.service_id === 'moltbook') {
        baseUrl = 'https://www.moltbook.com/api/v1';
      } else if (input.service_id === 'slack') {
        baseUrl = 'https://slack.com/api';
      } else {
        baseUrl = `https://api.${input.service_id}.com/v1`;
      }

      const httpMethod = input.method || (input.params ? 'POST' : 'GET');
      return await secureFetch({
        method: httpMethod,
        url: `${baseUrl}/${input.action}`,
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        data: httpMethod !== 'GET' ? input.params : undefined,
        params: httpMethod === 'GET' ? input.params : undefined
      });

    case 'CLI':
      assertUnsafeCliAllowed();
      const cliBin = `${input.service_id}`; 
      const args = [input.action, ...Object.values(input.params)];
      logger.info(`⌨️  [CLI] Executing: ${cliBin} ${args.join(' ')}`);
      return { output: safeExec(cliBin, args as string[]) };

    default:
      throw new Error(`Unsupported mode: ${input.mode}`);
  }
}

// ... CLI code (unchanged)
const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string) as ServiceAction;
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

// CLI Integration
const isMain = process.argv[1] && (
  process.argv[1].endsWith('service-actuator/src/index.ts') || 
  process.argv[1].endsWith('service-actuator/dist/index.js')
);

if (isMain) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
