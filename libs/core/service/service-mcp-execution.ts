/** One connected MCP client supplies discovery and the commit-time schema check. */
import {
  runExternalOperation,
  withExternalOperationInvocationAttempt,
  continueExternalOperationApproval,
  type ExternalOperationApprovalBlock,
} from '../governance/external-operation.js';
import { defaultOperationInterface } from '../governance/operation-protection.js';
import {
  describeRemoteMcpInterface,
  withTrustedRemoteMcpInterface,
  requireRemoteMcpInterface,
  remoteMcpServerDigest,
  assertRemoteMcpCommit,
  type RemoteMcpServer,
  type RemoteMcpTool,
} from '../governance/remote-mcp-interface.js';

interface ConnectedMcpClient {
  listTools(params?: { cursor?: string }): Promise<{ tools: RemoteMcpTool[]; nextCursor?: string }>;
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}
/** Explicit recovery after a consumed stdio startup. Never set from action JSON
 * or pick another identity automatically; the new startup needs its own consent. */
export function withMcpStartupAttempt<T>(attemptId: string, body: () => T): T {
  return withExternalOperationInvocationAttempt('mcp:connect', attemptId, body);
}
export interface McpApprovalContinuation {
  /** Trusted host callback; only a real shared-store decision permits execution. */
  onApprovalRequired?: (
    block: ExternalOperationApprovalBlock,
    signal: AbortSignal
  ) => Promise<void>;
  approvalWaitMs?: number;
}
function approvalWait(options?: McpApprovalContinuation) {
  if (!options?.onApprovalRequired) return;
  const timeoutMs = options.approvalWaitMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error(
      '[MCP_APPROVAL_WAIT_INVALID] Approval continuation must be bounded to 1..60000ms'
    );
  return async (block: ExternalOperationApprovalBlock) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.onApprovalRequired!(block, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  '[MCP_APPROVAL_WAIT_EXPIRED] Use a new separately approved startup attempt; no automatic respawn'
                )
              ),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  };
}
async function currentTools(client: ConnectedMcpClient): Promise<RemoteMcpTool[]> {
  const tools: RemoteMcpTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (tools.length > 4096 || seen.size > 64 || (cursor && seen.has(cursor)))
      throw new Error('[MCP_INTERFACE_REQUIRED] tools/list is incomplete or unbounded');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return tools;
}

/** A stdio server is executable code. Discovery never waives startup approval. */
export function connectGovernedMcpServer<T>(
  server: RemoteMcpServer,
  connect: () => Promise<T>,
  options?: McpApprovalContinuation
): Promise<T> {
  if (server.transport !== 'stdio') return connect();
  return continueExternalOperationApproval(
    () =>
      runExternalOperation(
        {
          operationId: 'mcp:connect',
          effect: {
            server_digest: remoteMcpServerDigest(server),
            command: server.command,
            args: server.args,
          },
          requiresApproval: true,
          delegable: false,
          interface: () => defaultOperationInterface('service:mcp')!,
        },
        connect,
        () => 'succeeded'
      ),
    approvalWait(options)
  );
}

/** Discovery provides a candidate interface, never an execution permission. */
export async function executeGovernedMcpTool(
  client: ConnectedMcpClient,
  server: RemoteMcpServer,
  name: string,
  args: Record<string, unknown>,
  options?: McpApprovalContinuation
): Promise<unknown> {
  const privateServer = structuredClone(server);
  const privateArgs = structuredClone(args);
  return continueExternalOperationApproval(async () => {
    const discovered = describeRemoteMcpInterface(privateServer, name, await currentTools(client));
    // Finish every asynchronous observation before final authority/source checks.
    // The admitted callback must invoke the SDK without another pre-dispatch await.
    const current = await currentTools(client);
    return withTrustedRemoteMcpInterface(
      () => discovered,
      () => {
        assertRemoteMcpCommit(privateServer, name, current, privateArgs);
        return runExternalOperation(
          {
            operationId: 'mcp:call_tool',
            effect: {
              server_digest: discovered.server_digest,
              tool_name: name,
              arguments: privateArgs,
            },
            requiresApproval: true,
            delegable: false,
            interface: () => requireRemoteMcpInterface(discovered.server_digest, name),
          },
          () => client.callTool({ name, arguments: privateArgs }),
          (result) =>
            result &&
            typeof result === 'object' &&
            (result as { isError?: boolean }).isError === true
              ? 'failed'
              : 'succeeded'
        );
      }
    );
  }, approvalWait(options));
}
