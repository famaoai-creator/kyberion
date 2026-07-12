import { logger, platform, secureFetch, safeExec } from './index.js';
import { retry } from './async-utils.js';
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
  stripUnresolvedTemplateValues,
} from './service-engine-helpers.js';
import { resolveServiceBinding } from './service-binding.js';

function buildChildEnv(env?: Record<string, unknown>): Record<string, string> | undefined {
  if (!env || typeof env !== 'object') return undefined;
  const entries = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export async function executeMcp(
  command: string,
  args: string[],
  actionRequest: { action: string; name?: string; arguments?: any },
  options?: { env?: Record<string, unknown> }
) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({
    command,
    args,
    env: buildChildEnv(options?.env),
    stderr: 'inherit',
  });
  const client = new Client(
    { name: 'Kyberion-Service-Engine', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    if (actionRequest.action === 'list_tools') return await client.listTools();
    if (actionRequest.action === 'list_resources') return await client.listResources();
    if (actionRequest.action === 'call_tool') {
      if (!actionRequest.name) throw new Error('Tool name is required for MCP call_tool');
      return await client.callTool({
        name: actionRequest.name,
        arguments: actionRequest.arguments || {},
      });
    }
    throw new Error(`Unsupported MCP action: ${actionRequest.action}`);
  } finally {
    try {
      await transport.close();
    } catch (_) {
      /* best-effort cleanup */
    }
  }
}

export async function executeRemoteMcp(
  url: string,
  actionRequest: { action: string; name?: string; arguments?: any },
  options?: { headers?: Record<string, unknown> }
) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: buildChildEnv(options?.headers),
    },
  });
  const client = new Client(
    { name: 'Kyberion-Service-Engine', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    if (actionRequest.action === 'list_tools') return await client.listTools();
    if (actionRequest.action === 'list_resources') return await client.listResources();
    if (actionRequest.action === 'call_tool') {
      if (!actionRequest.name) throw new Error('Tool name is required for MCP call_tool');
      return await client.callTool({
        name: actionRequest.name,
        arguments: actionRequest.arguments || {},
      });
    }
    throw new Error(`Unsupported MCP action: ${actionRequest.action}`);
  } finally {
    try {
      await transport.close();
    } catch (_) {
      /* best-effort cleanup */
    }
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
  input: ServicePresetAlternativeExecutionContext
): Promise<{ result: unknown } | null> {
  const runtimeVars = {
    ...input.mergedParams,
    ...input.binding,
  };

  if (input.alt.type === 'cli') {
    const bin = resolveVars(input.alt.command, runtimeVars);
    if (!(await platform.checkBinary(bin))) return null;
    if (!isCliAllowedForOperation(input.serviceConfig, input.preset, input.alt)) {
      throw new Error('CLI execution disabled.');
    }

    const rawOutput = await retry(
      async () => {
        const args = (input.alt.args || []).map((a: any) => {
          const resolved = resolveTemplateValue(a, runtimeVars);
          return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
        });
        const execEnv = buildChildEnv(
          stripUnresolvedTemplateValues(resolveTemplateValue(input.alt.env || {}, runtimeVars))
        );
        logger.info(`🚀 [ENGINE:CLI] Executing ${bin}`);
        return execEnv ? safeExec(bin, args, { env: execEnv }) : safeExec(bin, args);
      },
      buildRetryOptions(input.serviceConfig, input.preset, input.alt)
    );

    let parsed: unknown = rawOutput;
    try {
      parsed = JSON.parse(rawOutput);
    } catch (_) {
      const repaired = tryRepairJson(rawOutput);
      if (repaired !== null) parsed = repaired;
    }
    return { result: normalizePresetResult(parsed, input.alt.output_mapping) };
  }

  if (input.alt.type === 'mcp' && input.alt.url) {
    const remoteUrl = resolveVars(String(input.alt.url), runtimeVars);
    const mcpHeaders = buildChildEnv(
      stripUnresolvedTemplateValues(resolveTemplateValue(input.alt.headers || {}, runtimeVars))
    );

    const mcpResult = await retry(
      async () => {
        logger.info(`🚀 [ENGINE:MCP_HTTP] Executing ${remoteUrl} for ${input.action}`);
        return await executeRemoteMcp(
          remoteUrl,
          {
            action: input.alt.mcp_action || 'call_tool',
            name: resolveVars(input.alt.tool_name || input.action, runtimeVars),
            arguments: input.alt.payload_template
              ? resolveTemplateValue(input.alt.payload_template, runtimeVars)
              : input.params,
          },
          mcpHeaders ? { headers: mcpHeaders } : undefined
        );
      },
      buildRetryOptions(input.serviceConfig, input.preset, input.alt)
    );

    return { result: normalizePresetResult(mcpResult, input.alt.output_mapping) };
  }

  if (input.alt.type === 'mcp') {
    const bin = resolveVars(input.alt.command, runtimeVars);
    const args = (input.alt.args || []).map((a: any) => resolveVars(String(a), runtimeVars));
    if (!(await platform.checkBinary(bin))) return null;
    if (!isCliAllowedForOperation(input.serviceConfig, input.preset, input.alt)) {
      throw new Error('CLI execution disabled.');
    }
    const mcpEnv = buildChildEnv(
      stripUnresolvedTemplateValues(resolveTemplateValue(input.alt.env || {}, runtimeVars))
    );

    const mcpResult = await retry(
      async () => {
        logger.info(`🚀 [ENGINE:MCP] Executing ${bin} for ${input.action}`);
        return await executeMcp(
          bin,
          args,
          {
            action: input.alt.mcp_action || 'call_tool',
            name: resolveVars(input.alt.tool_name || input.action, runtimeVars),
            arguments: input.alt.payload_template
              ? resolveTemplateValue(input.alt.payload_template, runtimeVars)
              : input.params,
          },
          mcpEnv ? { env: mcpEnv } : undefined
        );
      },
      buildRetryOptions(input.serviceConfig, input.preset, input.alt)
    );

    return { result: normalizePresetResult(mcpResult, input.alt.output_mapping) };
  }

  if (input.alt.type === 'api') {
    const result = await retry(
      async () => {
        const baseUrl = resolveVars(
          input.alt.base_url ||
            input.preset.base_url ||
            input.serviceConfig.base_url ||
            input.mergedParams.base_url,
          runtimeVars
        );
        if (!baseUrl) {
          throw new Error(`No base_url resolved for service "${input.serviceId}"`);
        }
        const apiPath = resolveVars(input.alt.path, runtimeVars);
        const method = input.alt.method || 'GET';
        const authQuery = buildApiKeyQueryAuth(
          input.alt.auth_strategy || input.preset.auth_strategy,
          input.alt.auth_params || input.preset.auth_params,
          input.binding,
          runtimeVars
        );
        const rawQuery = input.envelope.query ?? (method === 'GET' ? input.params : undefined);
        const rawPayload = input.alt.payload_template
          ? resolveTemplateValue(input.alt.payload_template, input.mergedParams)
          : input.envelope.hasBody
            ? input.envelope.body
            : input.params;
        const headers = {
          ...(input.preset.headers || {}),
          ...(input.alt.headers || {}),
          ...buildAuthHeaders(input.alt.auth_strategy || input.preset.auth_strategy, input.binding),
        };
        const payload = prepareRequestBody(rawPayload, headers);
        const requestParams = isPlainObject(rawQuery)
          ? {
              ...resolveTemplateValue(rawQuery, runtimeVars),
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
          authenticateRequest:
            Object.keys(authQuery).length > 0 ||
            Boolean(headers.Authorization) ||
            Boolean(headers.authorization),
          kyberion_allow_local_network:
            Boolean(input.alt.allow_local_network) ||
            Boolean(input.preset.allow_local_network) ||
            Boolean(input.serviceConfig.allow_local_network),
        });
      },
      buildRetryOptions(input.serviceConfig, input.preset, input.alt)
    );

    return { result: normalizePresetResult(result, input.alt.output_mapping) };
  }

  return null;
}
