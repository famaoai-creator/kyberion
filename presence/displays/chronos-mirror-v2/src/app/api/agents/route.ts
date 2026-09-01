import { NextRequest, NextResponse } from 'next/server';
import {
  getChronosAccessRoleOrThrow,
  guardRequest,
  requireChronosAccess,
  roleToMissionRole,
} from '../../../lib/api-guard';
import { toWireError } from '@agent/core/wire-error';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContextAsync,
} from '../../../lib/viewer-context';
import { readChronosJsonObject } from '../../../lib/request-input';
import {
  chronosViewerCanAccessAgentScope,
  parseChronosAgentsBody,
} from '../agent/agent-route-helpers';

/**
 * /api/agents - Thin wrapper over Agent-Actuator
 *
 * GET    → health (list all agents with runtime snapshots)
 * POST   → spawn / ask / a2a / logs / refresh / restart / manual_* (via action field)
 * DELETE → shutdown
 */

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);
    const [
      { discoverProviders },
      { loadAgentManifests },
      { loadAgentProfileIndex },
      { agentRegistry },
      runtimeSupervisor,
      runtimeSupervisorClient,
    ] = await Promise.all([
      import('@agent/core/provider-discovery'),
      import('@agent/core/agent-manifest'),
      import('@agent/core/mission-team-index'),
      import('@agent/core/agent-registry'),
      import('@agent/core/agent-runtime-supervisor'),
      import('@agent/core/agent-runtime-supervisor-client'),
    ]);

    // ?providers=true returns installed provider info with models
    if (req.nextUrl.searchParams.get('providers') === 'true') {
      const providers = discoverProviders(req.nextUrl.searchParams.get('refresh') === 'true');
      return NextResponse.json({ status: 'ok', accessRole, providers });
    }

    // ?manifests=true returns available agent definitions
    if (req.nextUrl.searchParams.get('manifests') === 'true') {
      const profiles = loadAgentProfileIndex();
      const manifests = loadAgentManifests().map((m) => ({
        agentId: m.agentId,
        provider: m.selection_hints?.preferred_provider,
        modelId: m.selection_hints?.preferred_modelId,
        capabilities: m.capabilities,
        trustRequired: m.trustRequired,
        requiresEnv: m.requires.env || [],
        providerStrategy: profiles[m.agentId]?.provider_strategy || 'adaptive',
        fallbackProviders: profiles[m.agentId]?.fallback_providers || [],
      }));
      return NextResponse.json({ status: 'ok', accessRole, manifests });
    }

    const snapshot = agentRegistry.getHealthSnapshot();
    let agents;
    let healthOverride: { total: number; ready: number; busy: number; error: number } | null = null;
    try {
      const runtimes = await runtimeSupervisorClient.listAgentRuntimesViaDaemon();
      agents = runtimes.map((entry) => ({
        agentId: entry.agent_id,
        provider: entry.provider,
        modelId: entry.model_id,
        status: entry.status,
        capabilities: [],
        trustScore: 0,
        uptimeMs: 0,
        idleMs: 0,
        runtime: entry.pid
          ? {
              kind: 'agent',
              state: 'running',
              pid: entry.pid,
              idleForMs: 0,
              shutdownPolicy: 'manual',
            }
          : null,
        metrics: {
          turnCount: 0,
          errorCount: 0,
          restartCount: 0,
          refreshCount: 0,
          totalPromptChars: 0,
          totalResponseChars: 0,
        },
        process: null,
        supportsSoftRefresh: true,
        providerRuntime: entry.metadata || {},
        providerResolution: entry.metadata?.provider_resolution || null,
      }));
      healthOverride = {
        total: agents.length,
        ready: agents.filter((entry) => entry.status === 'ready').length,
        busy: agents.filter((entry) => entry.status === 'busy').length,
        error: agents.filter((entry) => entry.status === 'error').length,
      };
    } catch (_) {
      agents = runtimeSupervisor.listAgentRuntimeSnapshots().map((entry) => ({
        agentId: entry.agent.agentId,
        provider: entry.agent.provider,
        modelId: entry.agent.modelId,
        status: entry.agent.status,
        capabilities: entry.agent.capabilities,
        trustScore: entry.agent.trustScore,
        uptimeMs: Date.now() - entry.agent.spawnedAt,
        idleMs: Date.now() - entry.agent.lastActivity,
        runtime: entry.runtime
          ? {
              kind: entry.runtime.kind,
              state: entry.runtime.state,
              pid: entry.runtime.pid,
              idleForMs: entry.runtime.idleForMs,
              shutdownPolicy: entry.runtime.shutdownPolicy,
            }
          : null,
        metrics: entry.metrics,
        process: entry.process || null,
        supportsSoftRefresh: entry.supportsSoftRefresh,
        providerRuntime: entry.providerRuntime || {},
        providerResolution:
          (entry.agent.metadata as Record<string, unknown> | undefined)?.provider_resolution ||
          null,
      }));
    }
    return NextResponse.json({ status: 'ok', accessRole, ...(healthOverride || snapshot), agents });
  } catch (err: any) {
    return viewerErrorResponse(err, 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);
    const jsonBody = await readChronosJsonObject(req, 'Chronos agents');
    if (!jsonBody.ok) return NextResponse.json({ error: jsonBody.error }, { status: 400 });
    const parsedBody = parseChronosAgentsBody(jsonBody.body);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const { body, action } = parsedBody;
    const [runtimeSupervisor, runtimeSupervisorClient] = await Promise.all([
      import('@agent/core/agent-runtime-supervisor'),
      import('@agent/core/agent-runtime-supervisor-client'),
    ]);

    switch (action) {
      case 'spawn': {
        const forbidden = requireChronosAccess(req, 'localadmin');
        if (forbidden) return forbidden;
        if (!body.provider)
          return NextResponse.json({ error: 'Missing provider' }, { status: 400 });
        const payload = {
          agentId: body.agentId,
          provider: body.provider,
          modelId: body.modelId,
          systemPrompt: body.systemPrompt,
          capabilities: body.capabilities,
          runtimeMetadata: body.runtimeMetadata,
          requestedBy: 'chronos_agents_api',
        };
        try {
          const snapshot = await runtimeSupervisorClient.ensureAgentRuntimeViaDaemon(payload);
          return NextResponse.json({ status: 'spawned', agent: snapshot });
        } catch (_) {
          const handle = await runtimeSupervisor.ensureAgentRuntime(payload);
          return NextResponse.json({ status: 'spawned', agent: handle.getRecord() });
        }
      }
      case 'logs': {
        if (!body.agentId) return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });
        try {
          const snapshot = await runtimeSupervisorClient.getAgentRuntimeStatusViaDaemon(
            body.agentId,
            body.limit || 50
          );
          return NextResponse.json({
            status: 'ok',
            agentId: body.agentId,
            logs: snapshot?.log || [],
          });
        } catch (_) {
          const logs = runtimeSupervisor.getAgentRuntimeLog(body.agentId, body.limit || 50);
          return NextResponse.json({ status: 'ok', agentId: body.agentId, logs });
        }
      }
      case 'snapshot': {
        if (!body.agentId) return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });
        try {
          const snapshot = await runtimeSupervisorClient.getAgentRuntimeStatusViaDaemon(
            body.agentId,
            body.logLimit || 50
          );
          if (!snapshot)
            return NextResponse.json({ error: `Agent ${body.agentId} not found` }, { status: 404 });
          return NextResponse.json({ status: 'ok', snapshot });
        } catch (_) {
          const snapshot = runtimeSupervisor.getAgentRuntimeSnapshot(
            body.agentId,
            body.logLimit || 50
          );
          if (!snapshot)
            return NextResponse.json({ error: `Agent ${body.agentId} not found` }, { status: 404 });
          return NextResponse.json({ status: 'ok', snapshot });
        }
      }
      case 'ask': {
        const forbidden = requireChronosAccess(req, 'localadmin');
        if (forbidden) return forbidden;
        if (!body.agentId || !body.query)
          return NextResponse.json({ error: 'Missing agentId or query' }, { status: 400 });
        try {
          const response = await runtimeSupervisorClient.askAgentRuntimeViaDaemon({
            agentId: body.agentId,
            prompt: body.query,
            requestedBy: 'chronos_agents_api',
          });
          return NextResponse.json({
            status: 'ok',
            agentId: body.agentId,
            response: response.text,
          });
        } catch (_) {
          const handle = runtimeSupervisor.getAgentRuntimeHandle(body.agentId);
          if (!handle)
            return NextResponse.json(
              { error: `Agent ${body.agentId} not found or not ready` },
              { status: 404 }
            );
          const response = await handle.ask(body.query);
          return NextResponse.json({ status: 'ok', agentId: body.agentId, response });
        }
      }
      case 'refresh': {
        const forbidden = requireChronosAccess(req, 'localadmin');
        if (forbidden) return forbidden;
        if (!body.agentId) return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });
        try {
          const result = await runtimeSupervisorClient.refreshAgentRuntimeViaDaemon(
            body.agentId,
            'chronos_agents_api'
          );
          return NextResponse.json({ status: 'ok', agentId: body.agentId, ...result });
        } catch (_) {
          const result = await runtimeSupervisor.refreshAgentRuntime(
            body.agentId,
            'chronos_agents_api'
          );
          return NextResponse.json({ status: 'ok', agentId: body.agentId, ...result });
        }
      }
      case 'restart': {
        const forbidden = requireChronosAccess(req, 'localadmin');
        if (forbidden) return forbidden;
        if (!body.agentId) return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });
        try {
          const snapshot = await runtimeSupervisorClient.restartAgentRuntimeViaDaemon({
            agentId: body.agentId,
            provider: body.provider || 'gemini',
            modelId: body.modelId,
            systemPrompt: body.systemPrompt,
            capabilities: body.capabilities,
            runtimeMetadata: body.runtimeMetadata,
            requestedBy: 'chronos_agents_api',
          });
          return NextResponse.json({ status: 'ok', agentId: body.agentId, snapshot });
        } catch (_) {
          const handle = await runtimeSupervisor.restartAgentRuntime(
            body.agentId,
            'chronos_agents_api'
          );
          return NextResponse.json({
            status: 'ok',
            agentId: body.agentId,
            agent: handle.getRecord(),
            snapshot: runtimeSupervisor.getAgentRuntimeSnapshot(body.agentId),
          });
        }
      }
      case 'manual_peek':
      case 'manual_execute':
      case 'manual_resume':
      case 'manual_status':
      case 'manual_cancel': {
        const forbidden = requireChronosAccess(req, 'localadmin');
        if (forbidden) return forbidden;
        const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
        const {
          getAgentRuntimeManualDriverRegistration,
          readManualDriverDescriptor,
          enqueueManualDriverCommand,
          readManualDriverCommandStatus,
        } = await import('@agent/core/agent-runtime-manual-drive');
        const registration = getAgentRuntimeManualDriverRegistration(agentId);
        const durableDescriptor = readManualDriverDescriptor(agentId);
        const targetScope = registration?.scope ?? durableDescriptor?.scope;
        if (!targetScope) {
          return NextResponse.json(
            {
              error: `[MANUAL_DRIVE_RUNTIME_NOT_REGISTERED] agent '${agentId}' has no active manual-drive target.`,
            },
            { status: 409 }
          );
        }
        if (!chronosViewerCanAccessAgentScope(resolvedViewer.context, targetScope)) {
          return NextResponse.json(
            { error: 'Agent runtime is outside the viewer scope.' },
            { status: 403 }
          );
        }

        try {
          if (action === 'manual_status') {
            if (!durableDescriptor) {
              return NextResponse.json(
                { error: 'Manual-drive durable status is not available.' },
                { status: 409 }
              );
            }
            const status = readManualDriverCommandStatus(
              agentId,
              typeof body.commandId === 'string' ? body.commandId.trim() : ''
            );
            if (!status) {
              return NextResponse.json(
                { error: 'Manual-drive command was not found.' },
                { status: 404 }
              );
            }
            return NextResponse.json({
              status: status.state,
              agentId,
              commandId: status.commandId,
              ...(status.status ? { actionStatus: status.status } : {}),
              ...(status.action ? { action: status.action } : {}),
              ...(status.approval ? { approval: status.approval } : {}),
              ...(status.errorCode ? { errorCode: status.errorCode } : {}),
            });
          }
          if (action === 'manual_cancel') {
            if (!durableDescriptor) {
              return NextResponse.json(
                { error: 'Manual-drive durable cancellation is not available.' },
                { status: 409 }
              );
            }
            const { cancelManualDriverCommand } =
              await import('@agent/core/agent-runtime-manual-drive');
            const cancellation = await cancelManualDriverCommand({
              agentId,
              commandId: typeof body.commandId === 'string' ? body.commandId.trim() : '',
              cancelledBy: 'chronos_agents_api',
            });
            const responseStatus =
              cancellation === 'cancelled' ? 200 : cancellation === 'already_cleared' ? 404 : 409;
            return NextResponse.json(
              { status: cancellation, agentId, commandId: body.commandId },
              { status: responseStatus }
            );
          }
          if (action === 'manual_resume') {
            if (!durableDescriptor) {
              return NextResponse.json(
                { error: 'Manual-drive durable resume is not available.' },
                { status: 409 }
              );
            }
            if (registration) {
              return NextResponse.json(
                { error: 'Manual-drive resume is only available for a durable worker command.' },
                { status: 409 }
              );
            }
            const { resumeManualDriverCommand } =
              await import('@agent/core/agent-runtime-manual-drive');
            const receipt = await resumeManualDriverCommand({
              agentId,
              commandId: typeof body.commandId === 'string' ? body.commandId.trim() : '',
              resumedBy: 'chronos_agents_api',
            });
            return NextResponse.json(
              {
                status: 'queued',
                agentId,
                commandId: receipt.commandId,
                resumesCommandId: receipt.resumesCommandId,
                action: durableDescriptor.action,
              },
              { status: 202 }
            );
          }
          if (action === 'manual_peek') {
            const actionInfo = registration
              ? await withViewerExecutionContextAsync(resolvedViewer.context, () =>
                  registration.driver.peekAction()
                )
              : (durableDescriptor?.action ?? null);
            return NextResponse.json({ status: 'ok', agentId, action: actionInfo });
          }
          if (!registration) {
            const currentAction = durableDescriptor?.action;
            if (!currentAction || currentAction.action_id !== body.actionId) {
              return NextResponse.json(
                { error: 'The selected manual-drive action is no longer current.' },
                { status: 400 }
              );
            }
            const receipt = await enqueueManualDriverCommand({
              agentId,
              actionId: currentAction.action_id,
              requestedBy: 'chronos_agents_api',
            });
            return NextResponse.json(
              { status: 'queued', agentId, commandId: receipt.commandId, action: currentAction },
              { status: 202 }
            );
          }
          const result = await withViewerExecutionContextAsync(resolvedViewer.context, () =>
            registration.driver.executeAction(
              typeof body.actionId === 'string' ? body.actionId.trim() : undefined
            )
          );
          const wireError = result.error ? toWireError(new Error(result.error)) : undefined;
          return NextResponse.json({
            status: result.status,
            agentId,
            ...(result.action ? { action: result.action } : {}),
            ...(result.approval ? { approval: result.approval } : {}),
            ...(wireError
              ? {
                  error: wireError.message,
                  errorCode: wireError.code,
                  correlationId: wireError.correlation_id,
                }
              : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('[MANUAL_DRIVE_ACTION_MISMATCH]')) {
            return NextResponse.json(
              { error: 'The selected manual-drive action is no longer current.' },
              { status: 400 }
            );
          }
          const wireError = toWireError(error);
          return NextResponse.json(wireError, { status: 500 });
        }
      }
      case 'a2a': {
        const forbidden = requireChronosAccess(req, 'localadmin');
        if (forbidden) return forbidden;
        if (!body.envelope?.header)
          return NextResponse.json({ error: 'Invalid A2A envelope' }, { status: 400 });
        const { a2aBridge } = await import('@agent/core/a2a-bridge');
        const response = await a2aBridge.route(body.envelope);
        return NextResponse.json({ status: 'ok', response });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err: any) {
    return viewerErrorResponse(err, 500);
  }
}

export async function DELETE(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const forbidden = requireChronosAccess(req, 'localadmin');
    if (forbidden) return forbidden;
    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);
    const jsonBody = await readChronosJsonObject(req, 'Chronos agents');
    if (!jsonBody.ok) return NextResponse.json({ error: jsonBody.error }, { status: 400 });
    const parsedBody = parseChronosAgentsBody(jsonBody.body, { requireAgentId: true });
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const { body } = parsedBody;
    const [{ stopAgentRuntime }, runtimeSupervisorClient] = await Promise.all([
      import('@agent/core/agent-runtime-supervisor'),
      import('@agent/core/agent-runtime-supervisor-client'),
    ]);
    try {
      await runtimeSupervisorClient.shutdownAgentRuntimeViaDaemon(
        body.agentId,
        'chronos_agents_api'
      );
    } catch (_) {
      await stopAgentRuntime(body.agentId, 'chronos_agents_api');
    }
    return NextResponse.json({ status: 'shutdown', agentId: body.agentId });
  } catch (err: any) {
    return viewerErrorResponse(err, 500);
  }
}
