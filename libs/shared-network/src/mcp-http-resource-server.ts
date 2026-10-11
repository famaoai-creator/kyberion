/** Default-off, resource-server-only MCP adapter. No listener or authorization server. */
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Router,
} from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InsufficientScopeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { SUPPORTED_LOCALES } from '@agent/core/locale-normalize';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  HUMAN_REQUEST_READ_SCOPE,
  HUMAN_REQUEST_RECEIVE_SCOPE,
  resolveVerifiedHumanRequestIdentity,
  type HumanRequestServerPolicy,
  type VerifiedHumanRequestResolution,
} from '@agent/core/surface/verified-human-request-identity';
import type { MemberRegistryPathOptions } from '@agent/core/organization/member-registry';
import { runFrontDeskRequest } from '@agent/core/surface/front-desk-request-service';
import { readFrontDeskRequest } from '@agent/core/surface/front-desk-request-result';
import { frontDeskRuntimeScope } from '@agent/core/surface/front-desk-conversation-store';
import { CONVERSATION_MAX_INPUT } from '@agent/core/surface/front-desk-conversation-history';
import {
  createMcpAccessTokenVerifier,
  type McpAccessTokenVerifierConfig,
  type VerifiedMcpAccessToken,
} from './mcp-access-token.js';

export const MCP_REQUEST_TOOLS = {
  receive: 'kyberion.request.receive',
  status: 'kyberion.request.status',
  result: 'kyberion.request.result',
} as const;
const SCOPES = [HUMAN_REQUEST_READ_SCOPE, HUMAN_REQUEST_RECEIVE_SCOPE];
const TOOL_SCOPES: Readonly<Record<string, string>> = {
  [MCP_REQUEST_TOOLS.receive]: HUMAN_REQUEST_RECEIVE_SCOPE,
  [MCP_REQUEST_TOOLS.status]: HUMAN_REQUEST_READ_SCOPE,
  [MCP_REQUEST_TOOLS.result]: HUMAN_REQUEST_READ_SCOPE,
};
const selection = {
  tenant: z.string().min(1).max(128).optional(),
  organizationId: z.string().min(1).max(128).optional(),
  projectId: z.string().min(1).max(128).optional(),
  tier: z.enum(['public', 'confidential']).optional(),
};
const requestId = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const receiveSchema = z
  .object({
    ...selection,
    requestId,
    requestCreatedAt: z.number().int().nonnegative(),
    text: z.string().trim().min(1).max(CONVERSATION_MAX_INPUT),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
    sessionId: z.string().max(128).optional(),
  })
  .strict();
const readSchema = z.object({ ...selection, requestId }).strict();

export interface McpHttpResourceServerConfig {
  /** Only literal true creates any endpoint. This factory never opens a port. */
  enabled?: boolean;
  token: McpAccessTokenVerifierConfig;
  policy: HumanRequestServerPolicy;
  /** Exact HTTPS browser origins. The resource origin itself is always allowed. */
  allowedOrigins?: readonly string[];
}
export interface McpRequestAudit {
  operation: string;
  memberId: string;
  issuer: string;
  subject: string;
  tenant: string;
  requestId: string;
  transport: 'mcp-oauth';
}
export interface McpHttpResourceServerDependencies {
  memberRegistry?: MemberRegistryPathOptions;
  /** Trusted application seams, never wire-supplied handlers or identity. */
  receive?: typeof runFrontDeskRequest;
  read?: typeof readFrontDeskRequest;
  audit?: (event: McpRequestAudit) => void;
}
type AuthenticatedRequest = Request & { auth?: AuthInfo };

function defaultAudit(event: McpRequestAudit): void {
  auditChain.record({
    agentId: `user:${event.memberId}`,
    action: 'mcp_human_request',
    operation: event.operation,
    result: 'allowed',
    correlationId: event.requestId,
    tenantSlug: event.tenant,
    metadata: { ...event },
  });
}

/**
 * Mount this router at the application root only after separate operator approval.
 * It accepts an explicitly pinned RFC9068 JWT profile, not arbitrary OAuth tokens.
 * Authentication is repeated for every POST; no SDK/session/global user authority.
 */
export function createMcpHttpResourceServer(
  config?: McpHttpResourceServerConfig,
  dependencies: McpHttpResourceServerDependencies = {}
): Router {
  const router = express.Router({ strict: true });
  if (config?.enabled !== true) return router;
  const verifier = createMcpAccessTokenVerifier(config.token);
  const resource = new URL(config.token.resource);
  const issuer = config.token.issuer;
  if (resource.pathname === '/') throw new Error('MCP resource requires a distinct endpoint path');
  const policy = structuredClone(config.policy);
  const memberRegistry = dependencies.memberRegistry
    ? structuredClone(dependencies.memberRegistry)
    : undefined;
  const receive = dependencies.receive ?? runFrontDeskRequest;
  const read = dependencies.read ?? readFrontDeskRequest;
  const audit = dependencies.audit ?? defaultAudit;
  const origins = new Set([resource.origin]);
  for (const origin of config.allowedOrigins ?? []) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin)
      throw new Error('MCP browser origins must be exact HTTPS origins');
    origins.add(origin);
  }
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const metadataPath = new URL(metadataUrl).pathname;
  const gate: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (
      typeof host !== 'string' ||
      host.toLowerCase() !== resource.host.toLowerCase() ||
      (origin !== undefined && (typeof origin !== 'string' || !origins.has(origin)))
    ) {
      res.status(403).json({ error: 'invalid_request_origin' });
      return;
    }
    if (req.originalUrl.includes('?')) {
      res.status(400).json({ error: 'query_parameters_not_supported' });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
      res.vary('Origin');
    }
    next();
  };
  // SDK's combined metadata router also republishes AS metadata. Use only PRM.
  router.use(
    metadataPath,
    gate,
    metadataHandler({
      resource: resource.href,
      authorization_servers: [issuer],
      // Minimal initial grant; receive is requested by an operation-specific challenge.
      scopes_supported: [HUMAN_REQUEST_READ_SCOPE],
      bearer_methods_supported: ['header'],
    })
  );
  const bearer = requireBearerAuth({
    resourceMetadataUrl: metadataUrl,
    verifier: {
      async verifyAccessToken(token) {
        const verified = verifier.verify(token);
        // Re-read membership even for initialize/list/ping; never authenticate a suspended member.
        try {
          resolveVerifiedHumanRequestIdentity({
            identity: verified,
            policy,
            oauthScopes: verified.scopes,
            transport: 'mcp-oauth',
            memberRegistry,
          });
        } catch {
          throw new InsufficientScopeError('Active resource membership is required');
        }
        return {
          token,
          clientId: verified.clientId,
          scopes: [...verified.scopes],
          expiresAt: verified.expiresAt,
          resource: new URL(resource.href),
          extra: { verified },
        };
      },
    },
  });
  router.options(resource.pathname, gate, (req, res) => {
    const requested = req.headers['access-control-request-headers'];
    const headers = ['authorization', 'content-type', 'accept', 'mcp-protocol-version'];
    if (
      req.headers['access-control-request-method'] !== 'POST' ||
      (requested !== undefined &&
        (typeof requested !== 'string' ||
          requested.split(',').some((header) => !headers.includes(header.trim().toLowerCase()))))
    ) {
      res.status(403).json({ error: 'invalid_preflight' });
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
    res.status(204).end();
  });
  router.all(
    resource.pathname,
    gate,
    (req, res, next) => {
      const authorization = req.headers.authorization;
      const headerCount = req.rawHeaders.filter(
        (_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization'
      ).length;
      if (
        authorization !== undefined &&
        (headerCount !== 1 || !/^Bearer [A-Za-z0-9._~-]+$/i.test(authorization))
      ) {
        res.setHeader(
          'WWW-Authenticate',
          `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`
        );
        res.status(401).json({ error: 'invalid_token' });
        return;
      }
      next();
    },
    bearer,
    express.json({ limit: '32kb', strict: true }),
    async (req, res) => {
      const auth = (req as AuthenticatedRequest).auth!;
      const challenge = (scope: string) => {
        res.setHeader(
          'WWW-Authenticate',
          `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${metadataUrl}"`
        );
        res.status(403).json({ error: 'insufficient_scope' });
      };
      if (!SCOPES.some((scope) => auth.scopes.includes(scope))) {
        challenge(HUMAN_REQUEST_READ_SCOPE);
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        res.status(405).json({ error: 'method_not_allowed' });
        return;
      }
      const body = req.body as unknown;
      const envelope = z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.union([z.string(), z.number()]).optional(),
          method: z.enum([
            'initialize',
            'notifications/initialized',
            'ping',
            'tools/list',
            'tools/call',
          ]),
          params: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .safeParse(body);
      if (!envelope.success || req.headers['mcp-session-id'] !== undefined) {
        res.status(400).json({ error: 'invalid_mcp_request' });
        return;
      }
      const message = envelope.data;
      if ((message.method === 'notifications/initialized') !== (message.id === undefined)) {
        res.status(400).json({ error: 'invalid_mcp_request' });
        return;
      }
      let operation: string | undefined;
      let parsedInput: z.infer<typeof receiveSchema> | z.infer<typeof readSchema> | undefined;
      let identity: VerifiedHumanRequestResolution | undefined;
      if (message.method === 'tools/call') {
        const params = z
          .object({
            name: z.string(),
            arguments: z.unknown(),
            // Protocol metadata is never passed to identity, narrowing or execution.
            _meta: z.record(z.string(), z.unknown()).optional(),
          })
          .strict()
          .safeParse(message.params);
        operation = params.success ? params.data.name : undefined;
        if (!operation || !Object.hasOwn(TOOL_SCOPES, operation)) {
          res.status(400).json({ error: 'unknown_request_operation' });
          return;
        }
        const scope = TOOL_SCOPES[operation];
        if (!auth.scopes.includes(scope)) {
          challenge(scope);
          return;
        }
        const parsed = (
          operation === MCP_REQUEST_TOOLS.receive ? receiveSchema : readSchema
        ).safeParse(params.success ? params.data.arguments : undefined);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid_request_arguments' });
          return;
        }
        parsedInput = parsed.data;
        try {
          identity = resolveVerifiedHumanRequestIdentity({
            identity: auth.extra!.verified as unknown as VerifiedMcpAccessToken,
            policy,
            oauthScopes: auth.scopes,
            narrowing: parsedInput,
            transport: 'mcp-oauth',
            memberRegistry,
          });
          const needed =
            operation === MCP_REQUEST_TOOLS.receive
              ? 'surface.headless.write'
              : 'surface.headless.read';
          if (!identity.permissions.includes(needed)) {
            challenge(scope);
            return;
          }
          frontDeskRuntimeScope(identity.viewer);
        } catch {
          res.status(403).json({ error: 'request_scope_denied' });
          return;
        }
      }
      const server = new McpServer({ name: 'kyberion-human-requests', version: '1.0.0' });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [resource.host],
        allowedOrigins: [...origins],
      });
      const invoke = async (tool: string) => {
        if (operation !== tool || !parsedInput || !identity)
          throw new Error('request_context_required');
        const viewer = identity.viewer;
        if (viewer.tenantSlugs === 'all' || viewer.tenantSlugs.length !== 1)
          throw new Error('request_scope_selection_required');
        audit({
          operation: tool,
          memberId: viewer.memberId!,
          issuer: identity.transportEvidence.issuer,
          subject: identity.transportEvidence.subject,
          tenant: viewer.tenantSlugs[0],
          requestId: parsedInput.requestId,
          transport: 'mcp-oauth',
        });
        const result =
          tool === MCP_REQUEST_TOOLS.receive
            ? await receive(viewer, parsedInput as z.infer<typeof receiveSchema>)
            : read(viewer, parsedInput.requestId);
        const projection =
          result === undefined
            ? { kind: 'not_found', requestId: parsedInput.requestId }
            : tool === MCP_REQUEST_TOOLS.status && 'replyStatus' in result
              ? {
                  requestId: result.requestId,
                  sessionId: result.sessionId,
                  replyStatus: result.replyStatus,
                  work: result.work,
                }
              : result;
        return { content: [{ type: 'text' as const, text: JSON.stringify(projection) }] };
      };
      const safeInvoke = async (tool: string) => {
        try {
          return await invoke(tool);
        } catch {
          // Never expose storage, registry or execution exception details over MCP.
          // An unknown outcome is not permission to retry: the shared store owns it.
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'request_operation_failed' }],
          };
        }
      };
      server.registerTool(
        MCP_REQUEST_TOOLS.receive,
        {
          description:
            'Receive one scoped request. Reusing its ID never authorizes uncertain re-execution.',
          inputSchema: receiveSchema,
        },
        () => safeInvoke(MCP_REQUEST_TOOLS.receive)
      );
      server.registerTool(
        MCP_REQUEST_TOOLS.status,
        {
          description: 'Read current request status without executing or approving work.',
          inputSchema: readSchema,
        },
        () => safeInvoke(MCP_REQUEST_TOOLS.status)
      );
      server.registerTool(
        MCP_REQUEST_TOOLS.result,
        {
          description:
            'Read a saved reply and separately verified work state. A reply is not work completion.',
          inputSchema: readSchema,
        },
        () => safeInvoke(MCP_REQUEST_TOOLS.result)
      );
      res.on('close', () => {
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch {
        await server.close();
        if (!res.headersSent) res.status(500).json({ error: 'request_transport_failed' });
      }
    }
  );
  const parseError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status =
      typeof error === 'object' && error !== null && 'status' in error && error.status === 413
        ? 413
        : 400;
    if (!res.headersSent) res.status(status).json({ error: 'invalid_request_body' });
  };
  router.use(parseError);
  return router;
}
