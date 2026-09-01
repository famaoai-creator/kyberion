#!/usr/bin/env node
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { probeServiceRuntime, getServiceRuntimeRecord } from '@agent/core/service-runtime-registry';
import { loadServiceEndpointsCatalog } from '@agent/core/service-endpoint-registry';
import { inspectServiceAuth } from '@agent/core/service-validator';
import { safeExecResult } from '@agent/core/secure-io';
import { isRecord } from '@agent/core/foundation/text';

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

export function parseJsonProbeOutput(output: string): {
  ok: boolean;
  payload?: Record<string, unknown>;
  reason: string;
} {
  const trimmed = output.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty_output' };
  }
  const lastLine = trimmed.split(/\r?\n/).filter(Boolean).pop() || trimmed;
  try {
    const payload = JSON.parse(lastLine) as unknown;
    if (!isRecord(payload)) return { ok: false, reason: 'invalid_json_output' };
    const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : '';
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

  const ready = authReady && directProbeReady !== false && runtimeReady;
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

function formatHumanReport(report: Awaited<ReturnType<typeof runServicePreflight>>): string {
  return [
    ...report.reports.flatMap((item) => [
      `[service-preflight] ${item.serviceId}: ${item.status}`,
      `  auth=${item.authReady ? 'yes' : 'no'} direct=${item.directProbeReady === null ? 'n/a' : item.directProbeReady ? 'yes' : 'no'} runtime=${item.runtimeReady ? 'yes' : 'no'}`,
      `  reason=${item.reason}`,
    ]),
    '',
  ].join('\n');
}

async function main(args: string[] = []): Promise<Awaited<ReturnType<typeof runServicePreflight>>> {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const argv = await createStandardYargs(['node', 'service_preflight', ...normalizedArgs])
    .option('service', { type: 'string', describe: 'Service id to preflight' })
    .option('all', { type: 'boolean', default: false })
    .parseSync();

  return runServicePreflight({
    serviceId: argv.service ? String(argv.service) : undefined,
    all: Boolean(argv.all),
  });
}

if (
  isDirectScript(import.meta.url, 'service_preflight.ts') ||
  isDirectScript(import.meta.url, 'service_preflight.js')
)
  void defineScript({
    name: 'service:preflight',
    async run(context) {
      const report = await main(context.argv);
      context.print(context.json ? { status: 'ok', report } : formatHumanReport(report));
      if (!report.ready) {
        throw new ScriptExitError(1, '', true, report);
      }
      return report;
    },
  })();
