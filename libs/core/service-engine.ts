import { logger, safeReadFile, platform, transform, secureFetch, safeExec, resolveServiceBinding } from './index.js';
import * as path from 'node:path';

/**
 * Shared Service Execution Engine v1.0
 * Allows any Actuator to leverage Adaptive Presets (API/CLI).
 */

const SERVICE_ENDPOINTS_PATH = path.join(process.cwd(), 'knowledge/public/orchestration/service-endpoints.json');

function resolveVars(input: string, vars: Record<string, any>): string {
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

function isUnsafeCliAllowed(): boolean {
  return process.env.KYBERION_ALLOW_UNSAFE_CLI === 'true';
}

export async function executeServicePreset(serviceId: string, action: string, params: any, auth: 'none' | 'secret-guard' = 'none') {
  const endpoints = JSON.parse(safeReadFile(SERVICE_ENDPOINTS_PATH, { encoding: 'utf8' }) as string);
  const serviceConfig = endpoints.services[serviceId];
  if (!serviceConfig || !serviceConfig.preset_path) {
    throw new Error(`No preset path defined for service: ${serviceId}`);
  }
  
  const preset = JSON.parse(safeReadFile(path.resolve(process.cwd(), serviceConfig.preset_path), { encoding: 'utf8' }) as string);
  const op = preset.operations[action];
  if (!op) throw new Error(`Operation "${action}" not found in presets for ${serviceId}`);

  const alternatives = op.alternatives || [{ ...op, type: op.type || 'api' }];
  
  // Auth resolution
  const binding = resolveServiceBinding(serviceId, auth);
  const token = binding.accessToken;

  for (const alt of alternatives) {
    try {
      if (alt.type === 'cli') {
        const bin = resolveVars(alt.command, params);
        if (!(await platform.checkBinary(bin))) continue;
        if (!isUnsafeCliAllowed()) throw new Error('CLI execution disabled.');
        
        const args = (alt.args || []).map((a: any) => {
          const resolved = resolveTemplateValue(a, params);
          return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
        });
        logger.info(`🚀 [ENGINE:CLI] Executing ${bin}`);
        const rawOutput = safeExec(bin, args);
        let parsed = rawOutput;
        try { parsed = JSON.parse(rawOutput); } catch (_) {}
        return normalizePresetResult(parsed, alt.output_mapping);
      }

      if (alt.type === 'api') {
        const baseUrl = resolveVars(alt.base_url || preset.base_url || serviceConfig.base_url, params);
        const apiPath = resolveVars(alt.path, params);
        const method = alt.method || 'GET';
        const payload = alt.payload_template ? resolveTemplateValue(alt.payload_template, params) : params;
        
        const headers = { ...preset.headers, ...alt.headers };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        logger.info(`🚀 [ENGINE:API] Executing ${serviceId}:${action}`);
        const result = await secureFetch({
          method: method as any,
          url: `${baseUrl}/${apiPath}`,
          headers,
          data: method !== 'GET' ? payload : undefined,
          params: method === 'GET' ? payload : undefined
        });
        return normalizePresetResult(result, alt.output_mapping);
      }
    } catch (err: any) {
      logger.error(`  [ENGINE] Alternative failed: ${err.message}`);
    }
  }
  throw new Error(`All service alternatives failed for ${serviceId}:${action}`);
}
