import { createLogger } from '../logger.js';
import { platform } from '../platform.js';
import { secureFetch } from '../network.js';
import { safeExec } from '../secure-io.js';
import { retry } from '../async-utils.js';
import { tryRepairJson } from '../json-repair.js';
import type { ServicePresetRecord } from './service-preset-registry.js';
import {
  buildApiKeyQueryAuth,
  buildAuthHeaders,
  buildRetryOptions,
  isRetrySafeServiceOperation,
  ServiceEffectOutcomeUnknownError,
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
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { stripAuthorityEnvOverrides } from '../authority.js';
import {
  currentHumanExecutionAuthorization,
  hasHumanExecutionContext,
} from '../governance/human-execution.js';
import {
  currentDelegatedExecution,
  delegatedExecutionEffectConfigurationHash,
  hasDelegatedExecutionContext,
} from '../governance/delegated-execution.js';

const logger = createLogger('service-engine-execution');

function buildChildEnv(env?: Record<string, unknown>): Record<string, string> | undefined {
  if (!env || typeof env !== 'object') return undefined;
  const entries = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * A preset's child-process env overlay (`alt.env`): like buildChildEnv, but a
 * preset may not set execution authority (SYSTEM_ROLE, MISSION_ROLE,
 * KYBERION_PERSONA, KYBERION_DELEGATED_ROLE, KYBERION_SUDO — DR-01).
 */
export function buildPresetProcessEnv(
  env?: Record<string, unknown>
): Record<string, string> | undefined {
  const childEnv = buildChildEnv(env);
  if (!childEnv) return undefined;
  const stripped = stripAuthorityEnvOverrides(childEnv) as Record<string, string>;
  return Object.keys(stripped).length > 0 ? stripped : undefined;
}

/** Parse untrusted CLI output without allowing unsafe JSON objects into mappings. */
export function parseServiceCliOutput(rawOutput: string): unknown {
  try {
    return parseSafeJsonInput(rawOutput, 'service CLI JSON output');
  } catch (_) {
    return tryRepairJson(rawOutput) ?? rawOutput;
  }
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
    env: buildPresetProcessEnv(options?.env),
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
  /** Set only by the admitted, fixed authentication probe. */
  operatorProbe?: boolean;
  /** Trusted service-engine selector, never taken from the request body. */
  authSelector?: string;
  /** Digest of the actual loaded transport config, supplied only by service-engine. */
  effectConfigurationHash?: string;
}

function assertTransportAuthority(input: ServicePresetAlternativeExecutionContext): void {
  const operationId = `service:preset:${input.serviceId}:${input.action}`;
  const params = { request: input.params, auth: input.authSelector ?? 'none' };
  const active =
    currentHumanExecutionAuthorization(operationId, params) ??
    currentDelegatedExecution(operationId, params);
  if (
    active &&
    (!input.effectConfigurationHash ||
      input.effectConfigurationHash !== delegatedExecutionEffectConfigurationHash(active.target))
  ) {
    throw new Error(
      '[POLICY_VIOLATION] Loaded service configuration differs from authorized execution'
    );
  }
  if (
    hasHumanExecutionContext() &&
    !currentHumanExecutionAuthorization(`service:preset:${input.serviceId}:${input.action}`, {
      request: input.params,
      auth: input.authSelector ?? 'none',
    })
  )
    throw new Error('[POLICY_VIOLATION] Human service authority changed before transport dispatch');
  if (
    hasDelegatedExecutionContext() &&
    !currentDelegatedExecution(`service:preset:${input.serviceId}:${input.action}`, {
      request: input.params,
      auth: input.authSelector ?? 'none',
    })
  )
    throw new Error(
      '[POLICY_VIOLATION] Delegated service authority changed before transport dispatch'
    );
}

/** Only reviewed read operations with exclusively read-only HTTP routes may replay. */
export function isReplaySafeServiceOperation(operation: Record<string, unknown>): boolean {
  if (operation.risk !== undefined && operation.risk !== 'read') return false;
  const routes =
    Array.isArray(operation.alternatives) && operation.alternatives.length
      ? operation.alternatives
      : [operation];
  return routes.every(
    (route: unknown) =>
      isPlainObject(route) &&
      (route.type ?? 'api') === 'api' &&
      ['GET', 'HEAD'].includes(String(route.method ?? 'GET').toUpperCase())
  );
}

function alternativeRetryOptions(input: ServicePresetAlternativeExecutionContext) {
  if (input.operatorProbe || !isReplaySafeServiceOperation(input.preset.operations[input.action])) {
    return { maxRetries: 0 };
  }
  const options = buildRetryOptions(input.serviceConfig, input.preset, input.alt, {
    // Authenticated provider failures may echo credentials. Classify for retry
    // in memory only; never feed raw text to the unclassified-error registry.
    recordUnclassifiedErrors: input.binding.authMode !== 'secret-guard',
    retrySafe: isRetrySafeServiceOperation(input.preset, input.action, input.alt),
  });
  return input.binding.authMode === 'secret-guard'
    ? {
        ...options,
        onRetry: (_error: Error, attempt: number) => {
          logger.warn(
            '[ENGINE] Authenticated service request failed; retry attempt ' + attempt + '.'
          );
        },
      }
    : options;
}

export async function executeServicePresetAlternative(
  input: ServicePresetAlternativeExecutionContext
): Promise<{ result: unknown } | null> {
  let attempted = false;
  try {
    return await executeServicePresetAlternativeOnce(input, () => {
      attempted = true;
    });
  } catch (error) {
    if (
      attempted &&
      !input.operatorProbe &&
      !isRetrySafeServiceOperation(input.preset, input.action, input.alt)
    ) {
      throw new ServiceEffectOutcomeUnknownError();
    }
    throw error;
  }
}

async function executeServicePresetAlternativeOnce(
  input: ServicePresetAlternativeExecutionContext,
  markAttempted: () => void
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

    const rawOutput = await retry(async () => {
      const args = (input.alt.args || []).map((a: any) => {
        const resolved = resolveTemplateValue(a, runtimeVars);
        return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
      });
      const execEnv = buildPresetProcessEnv(
        stripUnresolvedTemplateValues(
          resolveTemplateValue(input.alt.env || {}, runtimeVars)
        ) as Record<string, unknown>
      );
      logger.info(`🚀 [ENGINE:CLI] Executing ${bin}`);
      assertTransportAuthority(input);
      markAttempted();
      return execEnv ? safeExec(bin, args, { env: execEnv }) : safeExec(bin, args);
    }, alternativeRetryOptions(input));

    const parsed = parseServiceCliOutput(rawOutput);
    return { result: normalizePresetResult(parsed, input.alt.output_mapping) };
  }

  if (input.alt.type === 'mcp' && input.alt.url) {
    const remoteUrl = resolveVars(String(input.alt.url), runtimeVars);
    const mcpHeaders = buildChildEnv(
      stripUnresolvedTemplateValues(
        resolveTemplateValue(input.alt.headers || {}, runtimeVars)
      ) as Record<string, unknown>
    );

    const mcpResult = await retry(async () => {
      logger.info(`🚀 [ENGINE:MCP_HTTP] Executing ${remoteUrl} for ${input.action}`);
      assertTransportAuthority(input);
      markAttempted();
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
    }, alternativeRetryOptions(input));

    return { result: normalizePresetResult(mcpResult, input.alt.output_mapping) };
  }

  if (input.alt.type === 'mcp') {
    const bin = resolveVars(input.alt.command, runtimeVars);
    const args = (input.alt.args || []).map((a: any) => resolveVars(String(a), runtimeVars));
    if (!(await platform.checkBinary(bin))) return null;
    if (!isCliAllowedForOperation(input.serviceConfig, input.preset, input.alt)) {
      throw new Error('CLI execution disabled.');
    }
    const mcpEnv = buildPresetProcessEnv(
      stripUnresolvedTemplateValues(
        resolveTemplateValue(input.alt.env || {}, runtimeVars)
      ) as Record<string, unknown>
    );

    const mcpResult = await retry(async () => {
      logger.info(`🚀 [ENGINE:MCP] Executing ${bin} for ${input.action}`);
      assertTransportAuthority(input);
      markAttempted();
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
    }, alternativeRetryOptions(input));

    return { result: normalizePresetResult(mcpResult, input.alt.output_mapping) };
  }

  if (input.alt.type === 'api') {
    const result = await retry(async () => {
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
            ...(resolveTemplateValue(rawQuery, runtimeVars) as Record<string, unknown>),
            ...authQuery,
          }
        : Object.keys(authQuery).length > 0
          ? authQuery
          : undefined;

      logger.info(`🚀 [ENGINE:API] Executing ${input.serviceId}:${input.action}`);
      assertTransportAuthority(input);
      markAttempted();
      return await secureFetch({
        ...(input.operatorProbe
          ? { maxRedirects: 0, maxContentLength: 65536, timeout: 10000 }
          : {}),
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
    }, alternativeRetryOptions(input));

    return { result: normalizePresetResult(result, input.alt.output_mapping) };
  }

  return null;
}
