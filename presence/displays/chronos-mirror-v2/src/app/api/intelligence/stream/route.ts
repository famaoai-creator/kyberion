import { NextRequest, NextResponse } from 'next/server';
import { collectA2AHandoffs, collectAgentMessages } from '../../../../lib/agent-message-feed';
import { buildRuntimeTopology } from '../../../../lib/runtime-topology';
import {
  collectBrowserSessions,
  collectControlActionDetails,
  collectControlActions,
  collectOwnerSummaries,
  collectRecentEvents,
} from '../../../../lib/intelligence-observations';
import {
  getChronosAccessRoleOrThrow,
  guardRequest,
  roleToMissionRole,
} from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
} from '../../../../lib/viewer-context';
import { resolveApprovalTenant } from '../../../../lib/su-surface-data';
import {
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
} from '@agent/core/agent-runtime-supervisor';
import { listApprovalRequests } from '@agent/core/approval-store';
import {
  loadSurfaceManifest,
  loadSurfaceState,
  normalizeSurfaceDefinition,
} from '@agent/core/surface-runtime';
import { deriveProviderPressure } from '@agent/core';

export const runtime = 'nodejs';

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function safeCollect<T>(label: string, fallback: T, collect: () => T): T {
  try {
    return collect();
  } catch (err) {
    console.warn(`[chronos-mirror-v2] ${label} failed`, err);
    return fallback;
  }
}

async function collectManagedRuntimeTopology() {
  const runtimeSupervisorClient = await import('@agent/core/agent-runtime-supervisor-client');
  const runtimeSnapshots = listAgentRuntimeSnapshots();
  const runtimeLeases = listAgentRuntimeLeaseSummaries();
  let managedRuntimes: Array<{
    agentId: string;
    provider: string;
    modelId?: string;
    status: string;
    ownerId: string;
    ownerType: string;
    requestedBy?: string;
    leaseKind?: string;
    pid?: number;
    metadata?: Record<string, unknown>;
    providerPressure?: ReturnType<typeof deriveProviderPressure>;
  }> = [];

  try {
    const daemonRuntimes = await runtimeSupervisorClient.listAgentRuntimesViaDaemon();
    managedRuntimes = daemonRuntimes.map((entry) => ({
      agentId: entry.agent_id,
      provider: entry.provider || 'unknown',
      modelId: entry.model_id || undefined,
      status: entry.status || 'unknown',
      ownerId: entry.owner_id || 'unowned',
      ownerType: entry.owner_type || 'unknown',
      requestedBy:
        typeof entry.metadata?.requestedBy === 'string' ? entry.metadata.requestedBy : undefined,
      leaseKind:
        typeof entry.metadata?.lease_kind === 'string' ? entry.metadata.lease_kind : undefined,
      pid: entry.pid,
      metadata: entry.metadata || undefined,
      providerPressure: deriveProviderPressure({
        quotaUsed:
          typeof entry.metadata?.quota_used === 'number' ? entry.metadata.quota_used : undefined,
        quotaLimit:
          typeof entry.metadata?.quota_limit === 'number' ? entry.metadata.quota_limit : undefined,
        remainingRatio:
          typeof entry.metadata?.quota_remaining_ratio === 'number'
            ? entry.metadata.quota_remaining_ratio
            : undefined,
        concurrentUsed:
          typeof entry.metadata?.concurrent_used === 'number'
            ? entry.metadata.concurrent_used
            : undefined,
        concurrentLimit:
          typeof entry.metadata?.concurrent_limit === 'number'
            ? entry.metadata.concurrent_limit
            : undefined,
        demoted: entry.status === 'demoted' || entry.status === 'error',
      }),
    }));
  } catch {
    managedRuntimes = runtimeLeases.map((lease) => {
      const snapshot = runtimeSnapshots.find((entry) => entry.agent.agentId === lease.agent_id);
      return {
        agentId: lease.agent_id,
        provider: snapshot?.agent.provider || 'unknown',
        modelId: snapshot?.agent.modelId,
        status: snapshot?.agent.status || 'unknown',
        ownerId: lease.owner_id,
        ownerType: lease.owner_type,
        requestedBy:
          typeof lease.metadata?.requestedBy === 'string' ? lease.metadata.requestedBy : undefined,
        leaseKind:
          typeof lease.metadata?.execution_mode === 'string'
            ? lease.metadata.execution_mode
            : undefined,
        pid: snapshot?.runtime?.pid,
        metadata: lease.metadata,
        providerPressure: deriveProviderPressure({
          quotaUsed:
            typeof lease.metadata?.quota_used === 'number' ? lease.metadata.quota_used : undefined,
          quotaLimit:
            typeof lease.metadata?.quota_limit === 'number'
              ? lease.metadata.quota_limit
              : undefined,
          remainingRatio:
            typeof lease.metadata?.quota_remaining_ratio === 'number'
              ? lease.metadata.quota_remaining_ratio
              : undefined,
          concurrentUsed:
            typeof lease.metadata?.concurrent_used === 'number'
              ? lease.metadata.concurrent_used
              : undefined,
          concurrentLimit:
            typeof lease.metadata?.concurrent_limit === 'number'
              ? lease.metadata.concurrent_limit
              : undefined,
          demoted: snapshot?.agent.status === 'error',
        }),
      };
    });
  }

  return {
    managedRuntimes,
    surfaces: loadSurfaceManifest()
      .surfaces.map(normalizeSurfaceDefinition)
      .map((surface) => {
        const record = loadSurfaceState().surfaces[surface.id];
        const alive = record
          ? (() => {
              try {
                process.kill(record.pid, 0);
                return true;
              } catch {
                return false;
              }
            })()
          : false;
        return {
          id: surface.id,
          kind: surface.kind,
          running: alive,
          startupMode: surface.startupMode,
          pid: alive ? record?.pid : undefined,
        };
      }),
    runtimeSummary: {
      total: runtimeSnapshots.length,
      ready: runtimeSnapshots.filter((entry) => entry.agent.status === 'ready').length,
      busy: runtimeSnapshots.filter((entry) => entry.agent.status === 'busy').length,
      error: runtimeSnapshots.filter((entry) => entry.agent.status === 'error').length,
    },
  };
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  let tenantSlugs: string[] | 'all';
  try {
    tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      req.nextUrl.searchParams.get('tenant') || undefined
    );
  } catch (error) {
    return viewerErrorResponse(error, 403);
  }

  const accessRole = getChronosAccessRoleOrThrow(req);
  process.env.MISSION_ROLE = roleToMissionRole(accessRole);

  const encoder = new TextEncoder();
  let previousPayload = '';
  let interval: NodeJS.Timeout | null = null;
  let closed = false;

  const closeStream = () => {
    if (closed) return;
    closed = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = async () => {
        if (closed) return;
        const agentMessages = safeCollect('collectAgentMessages', [], collectAgentMessages);
        const a2aHandoffs = safeCollect('collectA2AHandoffs', [], collectA2AHandoffs);
        const runtimeTopology = await (async () => {
          try {
            return await collectManagedRuntimeTopology();
          } catch (err) {
            console.warn('[chronos-mirror-v2] collectManagedRuntimeTopology failed', err);
            return {
              managedRuntimes: [],
              surfaces: [],
              runtimeSummary: { total: 0, ready: 0, busy: 0, error: 0 },
            };
          }
        })();
        const { managedRuntimes, surfaces, runtimeSummary } = runtimeTopology;
        if (closed) return;
        const scopedView = tenantSlugs !== 'all';
        const payload = {
          ts: new Date().toISOString(),
          accessRole,
          ...(scopedView
            ? {}
            : {
                recentEvents: safeCollect('collectRecentEvents', [], collectRecentEvents),
                agentMessages,
                a2aHandoffs,
              }),
          secretApprovals: safeCollect('listApprovalRequests', [], () =>
            listApprovalRequests({ kind: 'secret_mutation', status: 'pending' })
              .filter(
                (request) =>
                  tenantSlugs === 'all' ||
                  Boolean(
                    resolveApprovalTenant(request) &&
                    tenantSlugs.includes(resolveApprovalTenant(request)!)
                  )
              )
              .slice(0, 20)
              .map((request) => ({
                id: request.id,
                title: request.title,
                summary: request.summary,
                storageChannel: request.storageChannel,
                requestedAt: request.requestedAt,
                requestedBy: request.requestedBy,
                serviceId: request.target?.serviceId || 'unknown',
                secretKey: request.target?.secretKey || 'unknown',
                mutation: request.target?.mutation || 'set',
                riskLevel: request.risk?.level || 'medium',
                requiresStrongAuth: request.risk?.requiresStrongAuth === true,
                pendingRoles:
                  request.workflow?.approvals
                    .filter((approval) => approval.status === 'pending')
                    .map((approval) => approval.role) || [],
              }))
          ),
          ...(scopedView
            ? {
                controlActions: [],
                controlActionDetails: {},
                ownerSummaries: [],
                browserSessions: [],
                runtime: { total: 0, ready: 0, busy: 0, error: 0 },
                runtimeTopology: buildRuntimeTopology({
                  surfaces: [],
                  runtimes: [],
                  handoffs: [],
                  messages: [],
                }),
              }
            : {
                controlActions: safeCollect('collectControlActions', [], collectControlActions),
                controlActionDetails: safeCollect(
                  'collectControlActionDetails',
                  {},
                  collectControlActionDetails
                ),
                ownerSummaries: safeCollect('collectOwnerSummaries', [], collectOwnerSummaries),
                browserSessions: safeCollect('collectBrowserSessions', [], collectBrowserSessions),
                runtime: runtimeSummary,
                runtimeTopology: buildRuntimeTopology({
                  surfaces,
                  runtimes: managedRuntimes,
                  handoffs: a2aHandoffs,
                  messages: agentMessages,
                }),
              }),
        };
        const serialized = JSON.stringify(payload);
        if (serialized === previousPayload) return;
        previousPayload = serialized;
        try {
          controller.enqueue(encoder.encode(sseChunk(payload)));
        } catch {
          closeStream();
        }
      };

      try {
        controller.enqueue(encoder.encode('retry: 3000\n\n'));
      } catch {
        closeStream();
        return;
      }
      void push();
      interval = setInterval(() => {
        void push();
      }, 2000);
    },
    cancel() {
      closeStream();
    },
  });

  req.signal.addEventListener('abort', closeStream);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
