#!/usr/bin/env node
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  inspectServiceAuth,
  loadServiceEndpointsCatalog,
  logger,
  probeServiceRuntime,
  safeExecResult,
  getServiceRuntimeRecord,
} from '@agent/core';

type ServicePreflightStatus = 'ready' | 'needs_attention' | 'unavailable';

type ServicePreflightReport = {
  serviceId: string;
  status: ServicePreflightStatus;
  authReady: boolean;
  directProbeReady: boolean | null;
  runtimeReady: boolean;
  reason: string;
  authHint?: string;
  probeHint?: string;
  runtimeHint?: string;
};

type DirectProbe = {
  command: string;
  args?: string[];
  input: string;
  label: string;
};

function getDirectProbe(serviceId: string): DirectProbe | null {
  if (serviceId === 'voice') {
    return {
      label: 'voice bridge health',
      command: 'python3',
      args: ['libs/actuators/voice-actuator/scripts/voice_learning_bridge.py'],
      input: JSON.stringify({ action: 'health' }),
    };
  }
  if (serviceId === 'meeting') {
    return {
      label: 'meeting bridge status',
      command: 'python3',
      args: ['libs/actuators/meeting-actuator/meeting-bridge.py'],
      input: JSON.stringify({ action: 'status', params: { platform: 'auto' } }),
    };
  }
  return null;
}

function resolveRuntimeProbeServiceId(serviceId: string): string | null {
  if (serviceId === 'media-generation' || serviceId === 'vision') {
    return 'comfyui';
  }
  return getServiceRuntimeRecord(serviceId)?.service_id || null;
}

function parseJsonProbeOutput(output: string): { ok: boolean; payload?: any; reason: string } {
  const trimmed = output.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty_output' };
  }
  const lastLine = trimmed.split(/\r?\n/).filter(Boolean).pop() || trimmed;
  try {
    const payload = JSON.parse(lastLine);
    const status = String(payload?.status || '').toLowerCase();
    return {
      ok: status === 'ok' || status === 'success',
      payload,
      reason: status || 'unrecognized_status',
    };
  } catch {
    return { ok: false, reason: 'invalid_json_output' };
  }
}

async function probeService(serviceId: string): Promise<ServicePreflightReport> {
  const catalog = loadServiceEndpointsCatalog();
  const endpoint = catalog.services[serviceId];
  if (!endpoint) {
    return {
      serviceId,
      status: 'unavailable',
      authReady: false,
      directProbeReady: false,
      runtimeReady: false,
      reason: `service not found in catalog: ${serviceId}`,
    };
  }

  const authInspection = endpoint.preset_path
    ? inspectServiceAuth(serviceId, endpoint.preset_path)
    : null;
  const authReady = authInspection ? authInspection.valid : true;

  const directProbe = getDirectProbe(serviceId);
  let directProbeReady: boolean | null = null;
  let probeHint: string | undefined;
  if (directProbe) {
    const result = safeExecResult(directProbe.command, directProbe.args ?? [], {
      input: directProbe.input,
      timeoutMs: 30_000,
      maxOutputMB: 2,
    });
    const parsed = parseJsonProbeOutput(result.stdout);
    directProbeReady = parsed.ok;
    probeHint = parsed.ok
      ? `${directProbe.label} passed`
      : `${directProbe.label} failed: ${parsed.reason}${result.stderr ? `; stderr=${result.stderr.trim().slice(0, 200)}` : ''}`;
  }

  let runtimeReady = true;
  let runtimeHint: string | undefined;
  const runtimeServiceId = resolveRuntimeProbeServiceId(serviceId);
  if (runtimeServiceId) {
    const resolution = await probeServiceRuntime(runtimeServiceId, 'trial');
    runtimeReady = resolution.available;
    runtimeHint = resolution.available
      ? `runtime probe passed (${resolution.probe_url || resolution.base_url || resolution.managed_service_path || 'resolved'})`
      : `runtime probe failed: ${resolution.reason}`;
  }

  const ready = authReady && (directProbeReady !== false) && runtimeReady;
  const status: ServicePreflightStatus = ready
    ? 'ready'
    : authReady || directProbeReady === true || runtimeReady
      ? 'needs_attention'
      : 'unavailable';

  const hints = [
    !authReady && authInspection?.setupHint ? `auth: ${authInspection.setupHint}` : undefined,
    probeHint,
    runtimeHint,
  ].filter(Boolean);

  return {
    serviceId,
    status,
    authReady,
    directProbeReady,
    runtimeReady,
    reason: hints.join(' | ') || 'service preflight completed',
    authHint: authInspection?.setupHint,
    probeHint,
    runtimeHint,
  };
}

export async function runServicePreflight(options: {
  serviceId?: string;
  all?: boolean;
}): Promise<{ reports: ServicePreflightReport[]; ready: boolean }> {
  const catalog = loadServiceEndpointsCatalog();
  const serviceIds = options.all
    ? Object.keys(catalog.services)
    : [options.serviceId?.trim() || 'voice'];

  const reports: ServicePreflightReport[] = [];
  for (const serviceId of serviceIds) {
    reports.push(await probeService(serviceId));
  }

  return {
    reports,
    ready: reports.every((report) => report.status === 'ready'),
  };
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('service', { type: 'string', describe: 'Service id to preflight' })
    .option('all', { type: 'boolean', default: false })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const report = await runServicePreflight({
    serviceId: argv.service ? String(argv.service) : undefined,
    all: Boolean(argv.all),
  });

  if (!argv.json) {
    for (const item of report.reports) {
      console.log(`[service-preflight] ${item.serviceId}: ${item.status}`);
      console.log(`  auth=${item.authReady ? 'yes' : 'no'} direct=${item.directProbeReady === null ? 'n/a' : item.directProbeReady ? 'yes' : 'no'} runtime=${item.runtimeReady ? 'yes' : 'no'}`);
      console.log(`  reason=${item.reason}`);
    }
    console.log('');
  } else {
    logger.info(JSON.stringify({ status: 'ok', report }, null, 2));
  }

  process.exit(report.ready ? 0 : 1);
}

const isDirect = process.argv[1] && /service_preflight\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}
