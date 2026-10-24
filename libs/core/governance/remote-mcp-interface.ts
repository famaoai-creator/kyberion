/** Remote declarations are interface evidence; only the external approval gate authorizes calls. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { createAjv, createAjv2020 } from '../foundation/ajv.js';
import type { OperationInterfaceBinding } from './operation-protection.js';

export type RemoteMcpServer =
  | { transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; headers?: Record<string, string> };
export interface RemoteMcpTool {
  name: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}
export interface RemoteMcpInterfaceBinding extends OperationInterfaceBinding {
  server_digest: string;
  tool_name: string;
}
class RemoteMcpInterfaceError extends Error {
  readonly adfControlFlow = 'preflight';
  constructor(message: string) {
    super(`[MCP_INTERFACE_REQUIRED] ${message}`);
  }
}
const remote = new AsyncLocalStorage<() => RemoteMcpInterfaceBinding>();

/** A host resolver supplies actual server/tool identity, never an ADF/params assertion. */
export function withTrustedRemoteMcpInterface<T>(
  resolve: () => RemoteMcpInterfaceBinding,
  body: () => T
): T {
  return remote.run(resolve, body);
}
export function remoteMcpServerDigest(server: RemoteMcpServer): string {
  return computeApprovalPayloadHash({ server });
}
/** Pure observation conversion: constructing this descriptor grants no authority. */
export function describeRemoteMcpInterface(
  server: RemoteMcpServer,
  name: string,
  tools: readonly RemoteMcpTool[]
): RemoteMcpInterfaceBinding {
  if (!name || !Array.isArray(tools) || tools.length === 0 || tools.length > 4096)
    throw new RemoteMcpInterfaceError('A bounded current tools/list response is required');
  const candidates = tools.map((tool) => tool.name).sort();
  const matches = tools.filter((tool) => tool.name === name);
  if (
    new Set(candidates).size !== candidates.length ||
    matches.length !== 1 ||
    !matches[0]!.inputSchema ||
    typeof matches[0]!.inputSchema !== 'object' ||
    Array.isArray(matches[0]!.inputSchema)
  )
    throw new RemoteMcpInterfaceError('Tool name must resolve uniquely with an input schema');
  const server_digest = remoteMcpServerDigest(server);
  return {
    tool: `mcp:${server_digest}:${name}`,
    server_digest,
    tool_name: name,
    schema_digest: computeApprovalPayloadHash({ schema: matches[0]!.inputSchema }),
    capability_digest: computeApprovalPayloadHash({
      tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
    }),
    candidate_set: candidates,
  };
}
export function requireRemoteMcpInterface(
  serverDigest: string,
  name: string
): RemoteMcpInterfaceBinding {
  const current = remote.getStore()?.();
  if (
    !current ||
    current.server_digest !== serverDigest ||
    current.tool_name !== name ||
    current.tool !== `mcp:${serverDigest}:${name}` ||
    !current.candidate_set.includes(name) ||
    !/^[a-f0-9]{64}$/.test(current.schema_digest) ||
    !/^[a-f0-9]{64}$/.test(current.capability_digest)
  )
    throw new RemoteMcpInterfaceError(
      'Exact trusted server/tool/schema/candidate binding is missing'
    );
  return structuredClone(current);
}
/** Re-fetch on the same client immediately before callTool; never silently adopt drift. */
export function assertRemoteMcpCommit(
  server: RemoteMcpServer,
  name: string,
  tools: readonly RemoteMcpTool[],
  args: unknown
): void {
  const expected = requireRemoteMcpInterface(remoteMcpServerDigest(server), name);
  const observed = describeRemoteMcpInterface(server, name, tools);
  if (
    computeApprovalPayloadHash({ binding: expected }) !==
    computeApprovalPayloadHash({ binding: observed })
  )
    throw new RemoteMcpInterfaceError('Server schema or candidate set changed after admission');
  const selected = tools.find((tool) => tool.name === name)!;
  try {
    const dialect = selected.inputSchema.$schema;
    const draft2020 =
      dialect === undefined ||
      dialect === 'https://json-schema.org/draft/2020-12/schema' ||
      dialect === 'https://json-schema.org/draft/2020-12/schema#';
    const draft7 =
      typeof dialect === 'string' &&
      /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(dialect);
    if ((!draft2020 && !draft7) || selected.inputSchema.$async === true)
      throw new Error('unsupported or asynchronous schema dialect');
    const validate = (draft2020 ? createAjv2020() : createAjv()).compile(selected.inputSchema);
    if (validate(args) !== true) throw new Error('arguments violate current input schema');
  } catch {
    throw new RemoteMcpInterfaceError(
      'Arguments cannot be validated against the current tool schema'
    );
  }
}

/** Generic service:MCP cannot claim the wrapper manifest is the remote tool schema. */
export function remoteMcpBindingForEffect(
  operationId: string,
  effect: Record<string, unknown>
): RemoteMcpInterfaceBinding | undefined {
  if (operationId === 'mcp:call_tool') {
    if (typeof effect.server_digest !== 'string' || typeof effect.tool_name !== 'string')
      throw new RemoteMcpInterfaceError('Exact remote effect identity missing');
    return requireRemoteMcpInterface(effect.server_digest, effect.tool_name);
  }
  if (effect.mode !== 'MCP') return;
  const params = effect.params as Record<string, unknown> | undefined;
  if (!params || typeof effect.action !== 'string')
    throw new RemoteMcpInterfaceError('Malformed MCP service effect');
  if (['list_tools', 'list_resources'].includes(String(params.mcp_action))) return;
  return requireRemoteMcpInterface(
    remoteMcpServerDigest({
      transport: 'stdio',
      command: String(params.command || 'npx'),
      args: Array.isArray(params.args) ? params.args.map(String) : [],
    }),
    effect.action
  );
}
