import { logger, safeReadFile, platform, transform, secureFetch, safeExec, resolveServiceBinding, secretGuard } from './index.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';

/**
 * Shared Service Execution Engine v1.0
 * Allows any Actuator to leverage Adaptive Presets (API/CLI).
 */

const SERVICE_ENDPOINTS_PATH = pathResolver.knowledge('public/orchestration/service-endpoints.json');

function loadConnectionWithFallback(serviceId: string): Record<string, any> {
  const primary = withExecutionContext('service_actuator', () => secretGuard.loadConnectionDocument(serviceId));
  if (primary && typeof primary === 'object' && Object.keys(primary).length > 0) return primary;
  try {
    return withExecutionContext('service_actuator', () => {
      const fallbackPath = pathResolver.resolve(`knowledge/personal/connections/${serviceId}.json`);
      return JSON.parse(safeReadFile(fallbackPath, { encoding: 'utf8' }) as string);
    });
  } catch (_) {
    return {};
  }
}

function isUnresolvedTemplateString(value: unknown): value is string {
  return typeof value === 'string' && /^\{\{\s*[^}]+\s*\}\}$/.test(value.trim());
}

function mergeParamsWithConnection(connection: Record<string, any>, params: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...connection };
  for (const [key, value] of Object.entries(params || {})) {
    if (isUnresolvedTemplateString(value) && merged[key] !== undefined) continue;
    merged[key] = value;
  }
  return merged;
}

function resolveVars(input: string | undefined, vars: Record<string, any>): string {
  if (!input) return '';
  return input.replace(/{{(.*?)}}/g, (_, key) => {
    const value = vars[key.trim()];
    return value !== undefined ? String(value) : `{{${key}}}`;
  });
}

function resolveTemplateValue(input: any, vars: Record<string, any>): any {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const wholeVarMatch = trimmed.match(/^{{\s*([^}]+)\s*}}$/);
    if (wholeVarMatch) {
      const value = vars[wholeVarMatch[1].trim()];
      return value !== undefined ? value : input;
    }
    return resolveVars(input, vars);
  }
  if (Array.isArray(input)) {
    return input.map((item) => resolveTemplateValue(item, vars));
  }
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, resolveTemplateValue(value, vars)]),
    );
  }
  return input;
}

function normalizePresetResult(output: any, outputMapping?: Record<string, string>): any {
  if (!outputMapping || Object.keys(outputMapping).length === 0) return output;
  return transform(output, { type: 'json_map', mapping: outputMapping });
}

function buildAuthHeaders(
  authStrategy: string | undefined,
  binding: ReturnType<typeof resolveServiceBinding>,
): Record<string, string> {
  if (!authStrategy || authStrategy.toLowerCase() === 'none') return {};

  if (authStrategy.toLowerCase() === 'bearer') {
    if (!binding.accessToken) {
      throw new Error(`Bearer auth requires an access token for service "${binding.serviceId}"`);
    }
    return { Authorization: `Bearer ${binding.accessToken}` };
  }

  if (authStrategy.toLowerCase() === 'basic') {
    if (binding.clientId && binding.clientSecret) {
      const credentials = Buffer.from(`${binding.clientId}:${binding.clientSecret}`, 'utf8').toString('base64');
      return { Authorization: `Basic ${credentials}` };
    }
    if (binding.accessToken) {
      return { Authorization: `Basic ${binding.accessToken}` };
    }
    throw new Error(`Basic auth requires client credentials or a pre-encoded token for service "${binding.serviceId}"`);
  }

  return {};
}

function encodeFormBody(payload: Record<string, any>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) searchParams.append(key, String(item));
      continue;
    }
    searchParams.append(key, String(value));
  }
  return searchParams.toString();
}

function stripUnresolvedTemplateValues(input: any): any {
  if (typeof input === 'string') {
    return /^{{\s*[^}]+\s*}}$/.test(input.trim()) ? undefined : input;
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => stripUnresolvedTemplateValues(item))
      .filter((item) => item !== undefined);
  }
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input)
        .map(([key, value]) => [key, stripUnresolvedTemplateValues(value)])
        .filter(([, value]) => value !== undefined),
    );
  }
  return input;
}

function prepareRequestBody(payload: any, headers: Record<string, any>): any {
  const normalizedPayload = stripUnresolvedTemplateValues(payload);
  const contentType = String(headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded') && normalizedPayload && typeof normalizedPayload === 'object' && !Array.isArray(normalizedPayload)) {
    return encodeFormBody(normalizedPayload);
  }
  return normalizedPayload;
}

function isUnsafeCliAllowed(): boolean {
  return process.env.KYBERION_ALLOW_UNSAFE_CLI === 'true';
}

function isCliAllowedForOperation(
  serviceConfig: Record<string, any>,
  preset: Record<string, any>,
  operation: Record<string, any>,
): boolean {
  if (isUnsafeCliAllowed()) return true;
  return (
    Boolean(operation.allow_unsafe_cli) ||
    Boolean(preset.allow_unsafe_cli) ||
    Boolean(serviceConfig.allow_unsafe_cli)
  );
}

export async function executeServicePreset(serviceId: string, action: string, params: any, auth: 'none' | 'secret-guard' = 'none') {
  const endpoints = JSON.parse(safeReadFile(SERVICE_ENDPOINTS_PATH, { encoding: 'utf8' }) as string);
  const serviceConfig = endpoints.services[serviceId];
  if (!serviceConfig || !serviceConfig.preset_path) {
    throw new Error(`No preset path defined for service: ${serviceId}`);
  }
  
  const preset = JSON.parse(safeReadFile(pathResolver.rootResolve(serviceConfig.preset_path), { encoding: 'utf8' }) as string);
  const op = preset.operations[action];
  if (!op) throw new Error(`Operation "${action}" not found in presets for ${serviceId}`);

  const alternatives = op.alternatives || [{ ...op, type: op.type || 'api' }];
  const connection = loadConnectionWithFallback(serviceId);
  const mergedParams = {
    ...mergeParamsWithConnection(
      {
        ...(serviceConfig && typeof serviceConfig === 'object' ? serviceConfig : {}),
        ...(connection && typeof connection === 'object' ? connection : {}),
      },
      params && typeof params === 'object' ? params : {},
    ),
    [`${serviceId}_connection`]: connection,
  };
  
  // Auth resolution
  const binding = resolveServiceBinding(serviceId, auth);
  for (const alt of alternatives) {
    try {
      if (alt.type === 'cli') {
        const bin = resolveVars(alt.command, mergedParams);
        if (!(await platform.checkBinary(bin))) continue;
        if (!isCliAllowedForOperation(serviceConfig, preset, alt)) throw new Error('CLI execution disabled.');
        
        const args = (alt.args || []).map((a: any) => {
          const resolved = resolveTemplateValue(a, mergedParams);
          return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
        });
        logger.info(`🚀 [ENGINE:CLI] Executing ${bin}`);
        const rawOutput = safeExec(bin, args);
        let parsed = rawOutput;
        try { parsed = JSON.parse(rawOutput); } catch (_) {}
        return normalizePresetResult(parsed, alt.output_mapping);
      }

      if (alt.type === 'api') {
        const baseUrl = resolveVars(
          alt.base_url || preset.base_url || serviceConfig.base_url || connection.base_url,
          mergedParams,
        );
        if (!baseUrl) {
          throw new Error(`No base_url resolved for service "${serviceId}"`);
        }
        const apiPath = resolveVars(alt.path, mergedParams);
        const method = alt.method || 'GET';
        const rawPayload = alt.payload_template ? resolveTemplateValue(alt.payload_template, mergedParams) : params;
        const headers = {
          ...preset.headers,
          ...alt.headers,
          ...buildAuthHeaders(alt.auth_strategy || preset.auth_strategy, binding),
        };
        const payload = prepareRequestBody(rawPayload, headers);

        logger.info(`🚀 [ENGINE:API] Executing ${serviceId}:${action}`);
        const result = await secureFetch({
          method: method as any,
          url: `${baseUrl}/${apiPath}`,
          headers,
          data: method !== 'GET' ? payload : undefined,
          params: method === 'GET' ? payload : undefined,
          kyberion_allow_local_network:
            Boolean(alt.allow_local_network) ||
            Boolean(preset.allow_local_network) ||
            Boolean(serviceConfig.allow_local_network),
        });
        return normalizePresetResult(result, alt.output_mapping);
      }
    } catch (err: any) {
      logger.error(`  [ENGINE] Alternative failed: ${err.message}`);
    }
  }
  throw new Error(`All service alternatives failed for ${serviceId}:${action}`);
}
