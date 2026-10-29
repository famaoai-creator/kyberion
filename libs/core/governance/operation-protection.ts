/** Host-owned interface and argument evidence. Never populated from action JSON. */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { assertSafeRepositoryPath } from '../secure-io.js';
import { readTextFile } from '../foundation/text.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { pathResolver } from '../path-resolver.js';
import { verifyMemoryOrigin } from '../knowledge/memory-provenance.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';

export interface OperationInterfaceBinding {
  tool: string;
  schema_digest: string;
  capability_digest: string;
  candidate_set: string[];
}
class OperationInterfaceUnavailable extends Error {
  readonly adfControlFlow = 'preflight';
  constructor(cause: unknown) {
    super('[OP_INTERFACE_UNAVAILABLE] Cannot verify current reviewed tool interface', {
      cause,
    });
  }
}
const interfaces = new AsyncLocalStorage<() => OperationInterfaceBinding>();

/** The resolver reads CURRENT bytes at every admission/commit, not a cached catalog. */
export function withOperationInterface<T>(
  resolve: () => OperationInterfaceBinding,
  action: () => T
): T {
  return interfaces.run(resolve, action);
}

export function currentOperationInterface(): OperationInterfaceBinding | undefined {
  return interfaces.getStore()?.();
}

/** Only paths returned by the trusted actuator registry belong here. */
export function operationInterfaceResolver(input: {
  op: string;
  manifestPath: string;
  schemaPaths?: readonly string[];
}): () => OperationInterfaceBinding {
  const resolve = () => {
    const manifestPath = assertSafeRepositoryPath(pathResolver.rootResolve(input.manifestPath));
    const manifest = parseSafeJsonInput(readTextFile(manifestPath), 'operation manifest') as {
      contract_schema?: string;
      capabilities?: Array<{ op: string; schema_ref?: string }>;
    };
    const sources: Record<string, string> = {};
    const visited = new Set<string>();
    const readSchema = (file: string) => {
      const absolute = assertSafeRepositoryPath(file);
      if (visited.has(absolute)) return;
      if (visited.size >= 128) throw new Error('[OP_INTERFACE_UNAVAILABLE] Schema graph too large');
      visited.add(absolute);
      const bytes = readTextFile(absolute);
      sources[pathResolver.toRepoRelative(absolute)] = computeApprovalPayloadHash({ bytes });
      const schema = parseSafeJsonInput(bytes, 'operation schema');
      const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(visit);
        const object = node as Record<string, unknown>;
        if (typeof object.$ref === 'string' && !object.$ref.startsWith('#')) {
          const ref = object.$ref.split('#')[0]!;
          if (/^[a-z][a-z\d+.-]*:/iu.test(ref))
            throw new Error('[OP_INTERFACE_UNAVAILABLE] Remote schema references are not pinned');
          readSchema(path.resolve(path.dirname(absolute), ref));
        }
        Object.values(object).forEach(visit);
      };
      visit(schema);
    };
    const schemaRefs = new Set([
      ...(input.schemaPaths ?? []),
      manifest.contract_schema,
      ...(manifest.capabilities ?? []).map((capability) => capability.schema_ref),
    ]);
    for (const ref of schemaRefs) if (ref) readSchema(pathResolver.rootResolve(ref));
    if (Object.keys(sources).length === 0)
      throw new Error('[OP_INTERFACE_UNAVAILABLE] No reviewed operation schema');
    return {
      tool: input.op,
      schema_digest: computeApprovalPayloadHash(sources),
      capability_digest: computeApprovalPayloadHash({ manifest }),
      candidate_set: [...new Set((manifest.capabilities ?? []).map((entry) => entry.op))].sort(),
    };
  };
  return () => {
    try {
      return resolve();
    } catch (cause) {
      throw new OperationInterfaceUnavailable(cause);
    }
  };
}

/** Authoritative builtin schemas for direct callers as well as pipeline dispatch.
 * Unknown mutations must install a live resolver at their typed host boundary. */
export function defaultOperationInterface(
  operationId: string
): OperationInterfaceBinding | undefined {
  const domain = operationId.split(':')[0]!;
  const manifests: Readonly<Record<string, string>> = {
    service: 'libs/actuators/service-actuator/manifest.json',
    browser: 'libs/actuators/browser-actuator/manifest.json',
    email: 'libs/actuators/email-actuator/manifest.json',
    meeting: 'libs/actuators/meeting-actuator/manifest.json',
    calendar: 'libs/actuators/calendar-actuator/manifest.json',
    vcs: 'libs/actuators/vcs-actuator/manifest.json',
    network: 'libs/actuators/network-actuator/manifest.json',
    deployment: 'libs/actuators/deployment-actuator/manifest.json',
    voice: 'libs/actuators/voice-actuator/manifest.json',
    media: 'libs/actuators/media-generation-actuator/manifest.json',
  };
  if (operationId === 'video:filter_apply')
    return operationInterfaceResolver({
      op: operationId,
      manifestPath: 'knowledge/product/governance/video-filter-interface.json',
    })();
  if (operationId === 'tenant:attest_provider')
    return operationInterfaceResolver({
      op: operationId,
      manifestPath: 'knowledge/product/governance/provider-egress-policy.json',
      schemaPaths: [
        'knowledge/product/schemas/provider-egress-policy.schema.json',
        'knowledge/product/schemas/tenant-profile.schema.json',
      ],
    })();
  const manifestPath = manifests[domain];
  if (!manifestPath) return;
  return operationInterfaceResolver({
    op: operationId,
    manifestPath,
    ...(domain === 'calendar'
      ? { schemaPaths: ['knowledge/product/schemas/calendar-action.schema.json'] }
      : {}),
  })();
}

export interface OperationArgumentOrigin {
  /** Exact effect path, supplied by the trusted embedding runtime. */
  path: string[];
  value_hash: string;
  authority: 'user' | 'policy' | 'external';
  source?: {
    scope: MemoryScopeEnvelope;
    source_id: string;
    generation: number;
    sha256: string;
  };
}
const origins = new AsyncLocalStorage<readonly OperationArgumentOrigin[]>();

/** A model may describe lineage, but only a host may attest this evidence. */
export function withOperationArgumentOrigins<T>(
  evidence: readonly OperationArgumentOrigin[],
  action: () => T
): T {
  return origins.run(structuredClone(evidence), action);
}

/** Reviewed EFFECT paths, not guesses from argument names or model metadata.
 * An unmapped operation protects its whole effect until a narrower schema is reviewed. */
const PROTECTED_ARGUMENTS: Readonly<Record<string, readonly string[][]>> = {
  'browser:goto': [['params', 'url']],
  'browser:open_tab': [['params', 'url']],
  'vcs:pr_create': [['repository']],
  'vcs:pr_merge': [['repository'], ['baseRefName']],
  'vcs:push': [['url'], ['destination']],
  'service:slack:preset:post_message': [['params', 'channel']],
  'email:send': [['params', 'to'], ['params', 'cc'], ['params', 'from'], ['account']],
  'email:create_draft': [
    ['params', 'to'],
    ['params', 'cc'],
    ['params', 'from'],
  ],
  'meeting:chat': [['params', 'meeting_id']],
  'meeting:speak': [['params', 'meeting_id']],
};

function at(effect: unknown, segments: readonly string[]): unknown {
  let value = effect;
  for (const segment of segments) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(segment) ||
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, segment)
    )
      return;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** Reviewed destination fields, independent of content/claimed authority in the action. */
export function evaluateOperationArguments(
  operationId: string,
  effect: Record<string, unknown>,
  additionalPaths: readonly string[][] = []
): { requiresExactApproval: boolean; evidence_digest: string } {
  const evidence = origins.getStore() ?? [];
  for (const entry of evidence) {
    if (entry.source && !verifyMemoryOrigin(entry.source))
      throw new Error('[OP_ARGUMENT_SOURCE_REVOKED] Argument source is absent, changed or revoked');
  }
  const reviewed =
    PROTECTED_ARGUMENTS[operationId] ??
    (operationId.startsWith('service:') ? [['params']] : undefined);
  // A known schema whose required target is absent is not an unprotected call.
  const paths =
    reviewed?.length && at(effect, reviewed[0]!) !== undefined
      ? [...reviewed.filter((segments) => at(effect, segments) !== undefined), ...additionalPaths]
      : [[], ...additionalPaths];
  let requiresExactApproval = false;
  const bindings = paths.map((segments) => {
    const valueHash = computeApprovalPayloadHash({ value: at(effect, segments) });
    const origin = evidence.find(
      (entry) => entry.path.join('\0') === segments.join('\0') && entry.value_hash === valueHash
    );
    if (!origin || !['user', 'policy'].includes(origin.authority)) requiresExactApproval = true;
    return { path: segments, value_hash: valueHash, ...(origin ? { origin } : {}) };
  });
  return { requiresExactApproval, evidence_digest: computeApprovalPayloadHash({ bindings }) };
}
