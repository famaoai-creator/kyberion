import { logger, platform, secureFetch, safeExec, withRetry } from './index.js';
import { tryRepairJson } from './json-repair.js';
import type { ServicePresetRecord } from './service-preset-registry.js';
import {
  buildApiKeyQueryAuth,
  buildAuthHeaders,
  buildRetryOptions,
  isPlainObject,
  normalizePresetResult,
  prepareRequestBody,
  resolveRequestEnvelope,
  resolveTemplateValue,
  resolveVars,
  isCliAllowedForOperation,
} from './service-engine-helpers.js';
import { resolveServiceBinding } from './service-binding.js';

export async function executeMcp(command: string, args: string[], actionRequest: { action: string; name?: string; arguments?: any }) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({ command, args, stderr: 'inherit' });
  const client = new Client({ name: 'Kyberion-Service-Engine', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    if (actionRequest.action === 'list_tools') return await client.listTools();
    if (actionRequest.action === 'call_tool') {
      if (!actionRequest.name) throw new Error('Tool name is required for MCP call_tool');
      return await client.callTool({ name: actionRequest.name, arguments: actionRequest.arguments || {} });
    }
    throw new Error(`Unsupported MCP action: ${actionRequest.action}`);
  } finally {
    try {
      await transport.close();
    } catch (_) {}
  }
}

export interface ServicePresetAlternativeExecutionContext {
  serviceId: string;
  action: string;
  alt: Record<string, any>;
  serviceConfig: Record<string, any>;
  preset: ServicePresetRecord;
  params: any;
  envelope: ReturnType<typeof resolveRequestEnvelope>;
  mergedParams: Record<string, any>;
  binding: ReturnType<typeof resolveServiceBinding>;
}

export async function executeServicePresetAlternative(
  input: ServicePresetAlternativeExecutionContext,
): Promise<{ result: unknown } | null> {
  if (input.alt.type === 'cli') {
    const bin = resolveVars(input.alt.command, input.mergedParams);
    if (!(await platform.checkBinary(bin))) return null;
    if (!isCliAllowedForOperation(input.serviceConfig, input.preset, input.alt)) {
      throw new Error('CLI execution disabled.');
    }

    const rawOutput = await withRetry(async () => {
      const args = (input.alt.args || []).map((a: any) => {
        const resolved = resolveTemplateValue(a, input.mergedParams);
        return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
      });
      logger.info(`🚀 [ENGINE:CLI] Executing ${bin}`);
      return safeExec(bin, args);
    }, buildRetryOptions(input.serviceConfig, input.preset, input.alt));

    let parsed: unknown = rawOutput;
    try {
      parsed = JSON.parse(rawOutput);
    } catch (_) {
      const repaired = tryRepairJson(rawOutput);
      if (repaired !== null) parsed = repaired;
    }
    return { result: normalizePresetResult(parsed, input.alt.output_mapping) };
  }

  if (input.alt.type === 'mcp') {
    const bin = resolveVars(input.alt.command, input.mergedParams);
    const args = (input.alt.args || []).map((a: any) => resolveVars(String(a), input.mergedParams));
    if (!(await platform.checkBinary(bin))) return null;
    if (!isCliAllowedForOperation(input.serviceConfig, input.preset, input.alt)) {
      throw new Error('CLI execution disabled.');
    }

    const mcpResult = await withRetry(async () => {
      logger.info(`🚀 [ENGINE:MCP] Executing ${bin} for ${input.action}`);
      return await executeMcp(bin, args, {
        action: input.alt.mcp_action || 'call_tool',
        name: resolveVars(input.alt.tool_name || input.action, input.mergedParams),
        arguments: input.alt.payload_template
          ? resolveTemplateValue(input.alt.payload_template, input.mergedParams)
          : input.params,
      });
    }, buildRetryOptions(input.serviceConfig, input.preset, input.alt));

    return { result: normalizePresetResult(mcpResult, input.alt.output_mapping) };
  }

  if (input.alt.type === 'api') {
    const result = await withRetry(async () => {
      const baseUrl = resolveVars(
        input.alt.base_url || input.preset.base_url || input.serviceConfig.base_url || input.mergedParams.base_url,
        input.mergedParams,
      );
      if (!baseUrl) {
        throw new Error(`No base_url resolved for service "${input.serviceId}"`);
      }
      const apiPath = resolveVars(input.alt.path, input.mergedParams);
      const method = input.alt.method || 'GET';
      const authQuery = buildApiKeyQueryAuth(
        input.alt.auth_strategy || input.preset.auth_strategy,
        input.alt.auth_params || input.preset.auth_params,
        input.binding,
        input.mergedParams,
      );
      const rawQuery = input.envelope.query ?? (method === 'GET' ? input.params : undefined);
      const rawPayload = input.alt.payload_template
        ? resolveTemplateValue(input.alt.payload_template, input.mergedParams)
        : (input.envelope.hasBody ? input.envelope.body : input.params);
      const headers = {
        ...(input.preset.headers || {}),
        ...(input.alt.headers || {}),
        ...buildAuthHeaders(input.alt.auth_strategy || input.preset.auth_strategy, input.binding),
      };
      const payload = prepareRequestBody(rawPayload, headers);
      const requestParams = isPlainObject(rawQuery)
        ? {
            ...resolveTemplateValue(rawQuery, input.mergedParams),
            ...authQuery,
          }
        : Object.keys(authQuery).length > 0
          ? authQuery
          : undefined;

      logger.info(`🚀 [ENGINE:API] Executing ${input.serviceId}:${input.action}`);
      return await secureFetch({
        method: method as any,
        url: `${baseUrl}/${apiPath}`,
        headers,
        data: method !== 'GET' ? payload : undefined,
        params: requestParams ?? (method === 'GET' ? payload : undefined),
        authenticateRequest: Object.keys(authQuery).length > 0,
        kyberion_allow_local_network:
          Boolean(input.alt.allow_local_network) ||
          Boolean(input.preset.allow_local_network) ||
          Boolean(input.serviceConfig.allow_local_network),
      });
    }, buildRetryOptions(input.serviceConfig, input.preset, input.alt));

    return { result: normalizePresetResult(result, input.alt.output_mapping) };
  }

  return null;
}
