import { NextRequest, NextResponse } from 'next/server';
import { nowIso } from '@agent/core/foundation';
import { collectA2AHandoffs, collectAgentMessages } from '../../../../lib/agent-message-feed';
import { buildRuntimeTopology } from '../../../../lib/runtime-topology';
import { collectBrowserSessions } from '../../../../lib/intelligence-observations';
import {
  collectControlActionDetails,
  collectControlActions,
  collectOwnerSummaries,
  collectPendingSecretApprovals,
  collectRecentEvents,
} from '../intelligence-control-data';
import { getChronosAccessRoleOrThrow, guardRequest } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContextAsync,
} from '../../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../../lib/request-input';
import {
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
} from '@agent/core/agent-runtime-supervisor';
import {
  loadSurfaceManifest,
  loadSurfaceState,
  normalizeSurfaceDefinition,
} from '@agent/core/surface-runtime';
import { deriveProviderPressure } from '@agent/core/ce-adoption';
import * as intelligenceData from '../intelligence-observation-data';

export const runtime = 'nodejs';

let intelligenceStreamRevision = 0;

function nextIntelligenceStreamRevision(): number {
  intelligenceStreamRevision = Math.max(intelligenceStreamRevision + 1, Date.now());
  return intelligenceStreamRevision;
}

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

async function collectManagedRuntimeTopology(tierAccess?: readonly string[]) {
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
  let visibleAgentIds: Set<string> | undefined;

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

  if (tierAccess) {
    visibleAgentIds = new Set(
      runtimeLeases
        .filter((lease) => {
          const missionId =
            lease.owner_type === 'mission'
              ? lease.owner_id
              : typeof lease.metadata?.mission_id === 'string'
                ? lease.metadata.mission_id
                : undefined;
          return missionId
            ? intelligenceData.missionVisibleToScope(missionId, 'all', tierAccess)
            : tierAccess.includes('confidential');
        })
        .map((lease) => lease.agent_id)
    );
    managedRuntimes = managedRuntimes.filter((runtime) => visibleAgentIds!.has(runtime.agentId));
  }

  const scopedRuntimeSnapshots = visibleAgentIds
    ? runtimeSnapshots.filter((entry) => visibleAgentIds!.has(entry.agent.agentId))
    : runtimeSnapshots;

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
      total: scopedRuntimeSnapshots.length,
      ready: scopedRuntimeSnapshots.filter((entry) => entry.agent.status === 'ready').length,
      busy: scopedRuntimeSnapshots.filter((entry) => entry.agent.status === 'busy').length,
      error: scopedRuntimeSnapshots.filter((entry) => entry.agent.status === 'error').length,
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
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'))
    );
  } catch (error) {
    return viewerErrorResponse(error, 403);
  }
  const tierAccess = resolvedViewer.context.tierAccess ?? ['public', 'confidential'];

  const accessRole = getChronosAccessRoleOrThrow(req);
  const broadOperationalAccess = tenantSlugs === 'all' && tierAccess.includes('confidential');

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
      const push = async () =>
        withViewerExecutionContextAsync(resolvedViewer.context, async () => {
          if (closed) return;
          const agentMessages = safeCollect(
            'collectAgentMessages',
            [],
            collectAgentMessages
          ).filter((message) =>
            intelligenceData.missionVisibleToScope(message.missionId, tenantSlugs, tierAccess)
          );
          const a2aHandoffs = safeCollect('collectA2AHandoffs', [], collectA2AHandoffs).filter(
            (handoff) =>
              intelligenceData.missionVisibleToScope(handoff.missionId, tenantSlugs, tierAccess)
          );
          const runtimeTopology = await (async () => {
            try {
              return await collectManagedRuntimeTopology(tierAccess);
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
            revision: nextIntelligenceStreamRevision(),
            ts: nowIso(),
            accessRole,
            ...(scopedView
              ? {}
              : {
                  recentEvents: safeCollect('collectRecentEvents', [], () =>
                    collectRecentEvents(tenantSlugs, tierAccess)
                  ),
                  agentMessages,
                  a2aHandoffs,
                }),
            secretApprovals: safeCollect('collectPendingSecretApprovals', [], () =>
              collectPendingSecretApprovals(tenantSlugs, tierAccess)
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
                  controlActions: safeCollect('collectControlActions', [], () =>
                    collectControlActions(tenantSlugs, tierAccess)
                  ),
                  controlActionDetails: safeCollect('collectControlActionDetails', {}, () =>
                    collectControlActionDetails(tenantSlugs, tierAccess)
                  ),
                  ownerSummaries: safeCollect('collectOwnerSummaries', [], () =>
                    collectOwnerSummaries(tenantSlugs, tierAccess)
                  ),
                  browserSessions: broadOperationalAccess
                    ? safeCollect('collectBrowserSessions', [], collectBrowserSessions)
                    : [],
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
        });

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
