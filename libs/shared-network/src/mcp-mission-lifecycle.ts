/** Mission-owner MCP operations delegate to the canonical controller, never edit state. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  resolveMcpRequestContext,
  assertMcpCallerRole,
  type McpRequestContext,
} from '@agent/core/mcp-request-context';
import { loadState } from '@agent/core/mission/mission-state';
import { missionMutationSnapshot } from '@agent/core/mission/mission-mutation-snapshot';
import { buildExecutionEnv, resolveIdentityContext } from '@agent/core/authority';
import { safeExecResultAsync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  claimApprovalApply,
  computeApprovalPayloadHash,
  loadApprovalRequest,
  recordApprovalApplyResult,
} from '@agent/core/governance/approval-store';
import { nowIso } from '@agent/core/foundation';
import { formatWireError } from '@agent/core/wire-error';
import type { RegisterGovernedTool, ToolCatalog } from './mcp-server-engine.js';

export const MCP_MISSION_LIFECYCLE_OPERATIONS = [
  'record_evidence',
  'review_task',
  'verify',
  'distill',
  'finish',
] as const;
type MissionOperation = (typeof MCP_MISSION_LIFECYCLE_OPERATIONS)[number];
interface ApprovalInput {
  context: McpRequestContext;
  approvalRef?: string;
  payload: Record<string, unknown>;
  effectBinding: string;
  title: string;
  summary: string;
  details: string;
}
export interface MissionLifecycleToolDeps {
  approve: (input: ApprovalInput) => { allowed: boolean; request_id?: string; status: string };
  state?: typeof loadState;
  execute?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  /** Server-owned process binding; never obtained from model arguments. */
  ownerBinding?: () => { missionId?: string; role?: string };
  snapshot?: (
    missionId: string,
    operation: MissionOperation,
    taskId: string | undefined,
    state: NonNullable<ReturnType<typeof loadState>>
  ) => string;
  reserve?: (
    approvalId: string,
    actor: string,
    payload: Record<string, unknown>,
    context: McpRequestContext,
    effectBinding: string
  ) => string;
  settle?: (
    approvalId: string,
    claimId: string,
    actor: string,
    result: 'success' | 'failed'
  ) => void;
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function missionSnapshot(
  missionId: string,
  operation: MissionOperation,
  taskId: string | undefined,
  state: NonNullable<ReturnType<typeof loadState>>
): string {
  return missionMutationSnapshot(missionId, operation, taskId, state);
}

function reserveApproval(
  approvalId: string,
  actor: string,
  payload: Record<string, unknown>,
  context: McpRequestContext,
  effectBinding: string
): string {
  const record = loadApprovalRequest('mcp-approval', approvalId);
  if (
    !record ||
    record.accountability?.payloadHash !== computeApprovalPayloadHash(payload) ||
    record.accountability?.effectBinding !== effectBinding ||
    computeApprovalPayloadHash({ scope: record.scope }) !==
      computeApprovalPayloadHash({ scope: context.scope })
  )
    throw new Error('[MCP_APPROVAL_PAYLOAD_MISMATCH] Approval changed before execution');
  return claimApprovalApply('mission_controller', {
    channel: 'mcp-approval',
    requestId: approvalId,
    appliedBy: actor,
    expectedRecordHash: computeApprovalPayloadHash({ record }),
  }).applyClaim.claimId;
}

function settleApproval(
  approvalId: string,
  claimId: string,
  actor: string,
  result: 'success' | 'failed'
): void {
  recordApprovalApplyResult('mission_controller', {
    channel: 'mcp-approval',
    requestId: approvalId,
    claimId,
    applyResult: { appliedAt: nowIso(), appliedBy: actor, result },
  });
}

/** The request role and tenant are server-established; model arguments cannot claim ownership. */
export async function executeMcpMissionLifecycle(
  operation: MissionOperation,
  args: {
    mission_id: string;
    tenant?: string;
    tier?: 'public' | 'confidential' | 'personal';
    task_id?: string;
    note?: string;
    result?: 'verified' | 'rejected';
    findings?: unknown[];
    approval_ref?: string;
  },
  context: McpRequestContext,
  deps: MissionLifecycleToolDeps
): Promise<unknown> {
  assertMcpCallerRole(context, ['operator', 'agent'], `kyberion.mission.${operation}`);
  const missionId = args.mission_id.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]+$/.test(missionId))
    throw new Error('[MCP_MISSION_ID_INVALID] Invalid mission id');
  const binding =
    deps.ownerBinding?.() ??
    (() => {
      const identity = resolveIdentityContext();
      return { missionId: identity.missionId, role: identity.role };
    })();
  if (binding.role !== 'mission_controller' || binding.missionId?.toUpperCase() !== missionId)
    throw new Error(
      '[MCP_MISSION_OWNER_REQUIRED] Server must be bound to this mission owner; client mission arguments cannot establish ownership'
    );
  if (context.caller_role === 'agent' && !context.nhi_id)
    throw new Error(
      '[MCP_MISSION_ACTOR_REQUIRED] Owner-agent calls require a server-bound NHI identity'
    );
  if (operation === 'review_task' && !context.nhi_id)
    throw new Error(
      '[MCP_MISSION_REVIEWER_REQUIRED] Review requires a server-bound NHI reviewer identity'
    );
  const actor = context.nhi_id ?? `service:mcp-owner-${digest(context.principal).slice(0, 16)}`;
  const actorType = context.nhi_id ? 'agent' : 'service';
  const state = (deps.state ?? loadState)(missionId);
  if (
    !state ||
    state.mission_id !== missionId ||
    state.tier !== context.scope.tier ||
    (state.tenant_slug ?? '') !== (context.scope.tenant_slug ?? '')
  )
    throw new Error('[MCP_SCOPE_MISMATCH] Mission is outside server scope');
  if (context.scope.mission_id && context.scope.mission_id !== missionId)
    throw new Error('[MCP_SCOPE_MISMATCH] Mission is outside bound owner context');
  if (!MCP_MISSION_LIFECYCLE_OPERATIONS.includes(operation))
    throw new Error('[MCP_MISSION_OPERATION_DENIED] Unknown lifecycle operation');
  const argv: string[] = [];
  if (args.task_id && !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(args.task_id))
    throw new Error('[MCP_MISSION_INPUT] Invalid task id');
  if (args.note?.startsWith('-'))
    throw new Error('[MCP_MISSION_INPUT] Note cannot begin with a CLI option');
  switch (operation) {
    case 'record_evidence':
      if (!args.task_id?.trim() || !args.note?.trim())
        throw new Error('[MCP_MISSION_INPUT] task_id and note required');
      argv.push(
        'record-evidence',
        missionId,
        args.task_id,
        args.note,
        '--actor-id',
        actor,
        '--actor-type',
        actorType
      );
      break;
    case 'review_task':
      if (!args.task_id?.trim()) throw new Error('[MCP_MISSION_INPUT] task_id required');
      argv.push(
        'review-task',
        missionId,
        args.task_id,
        actor,
        '--findings',
        JSON.stringify(args.findings ?? [])
      );
      break;
    case 'verify':
      if (!args.result || !['verified', 'rejected'].includes(args.result) || !args.note?.trim())
        throw new Error('[MCP_MISSION_INPUT] verification result and note required');
      argv.push('verify', missionId, args.result, args.note);
      break;
    case 'distill':
      argv.push('distill', missionId);
      break;
    case 'finish':
      argv.push('finish', missionId);
      break;
  }
  const snapshot = deps.snapshot ?? missionSnapshot;
  const initialSnapshot = snapshot(missionId, operation, args.task_id, state);
  const payload = {
    operation: `mission.${operation}`,
    mission_id: missionId,
    task_id: args.task_id,
    note: args.note,
    result: args.result,
    findings: args.findings,
    actor_id: actor,
    actor_type: actorType,
    mission_snapshot: initialSnapshot,
  };
  const approval = deps.approve({
    context,
    approvalRef: args.approval_ref,
    payload,
    effectBinding: `mission.${operation}:${missionId}:${args.task_id ?? ''}`,
    title: `Mission ${operation}: ${missionId}`,
    summary: `Bound mission owner ${context.principal} requested ${operation}.`,
    details: JSON.stringify(payload),
  });
  if (!approval.allowed) return { status: approval.status, request_id: approval.request_id };
  const approvalId = args.approval_ref ?? approval.request_id;
  if (!approvalId) throw new Error('[MCP_APPROVAL_REQUIRED] Exact approval reference required');
  const claimId = (deps.reserve ?? reserveApproval)(
    approvalId,
    actor,
    payload,
    context,
    `mission.${operation}:${missionId}:${args.task_id ?? ''}`
  );
  const latest = (deps.state ?? loadState)(missionId);
  if (!latest || snapshot(missionId, operation, args.task_id, latest) !== initialSnapshot) {
    (deps.settle ?? settleApproval)(approvalId, claimId, actor, 'failed');
    throw new Error(
      '[MCP_MISSION_STALE_APPROVAL] Mission or reviewed artifact changed; request fresh approval'
    );
  }
  const env = buildExecutionEnv(process.env, 'mission_controller');
  env.MISSION_ID = missionId;
  if (state.tenant_slug) env.KYBERION_TENANT = state.tenant_slug;
  else delete env.KYBERION_TENANT;
  if (state.organization_id) env.KYBERION_ORGANIZATION_ID = state.organization_id;
  else delete env.KYBERION_ORGANIZATION_ID;
  const execute =
    deps.execute ??
    (async (argv, env) => {
      const root = pathResolver.rootDir();
      const result = await safeExecResultAsync(
        process.execPath,
        [path.join(root, 'dist/scripts/mission_controller.bundle.js'), ...argv],
        { cwd: root, env, timeoutMs: 120_000, maxOutputMB: 2 }
      );
      if (result.status !== 0 || result.error)
        throw new Error(
          `[MCP_MISSION_CONTROLLER_FAILED] ${operation}: ${result.stderr || result.error || result.status}`
        );
      return result.stdout;
    });
  try {
    const output = await execute([...argv, '--expected-snapshot', initialSnapshot], env);
    (deps.settle ?? settleApproval)(approvalId, claimId, actor, 'success');
    return { status: 'executed', mission_id: missionId, output };
  } catch {
    // A child may have committed before its transport failed. Keep the durable
    // apply claim: retrying the same approval must never repeat uncertain effects.
    throw new Error(
      `[MCP_MISSION_EFFECT_UNCERTAIN] Mission operation requires reconciliation; approval ${approvalId} claim ${claimId} is reserved`
    );
  }
}

export function registerMcpMissionLifecycleTools(params: {
  server: McpServer;
  catalog: ToolCatalog;
  registerGovernedTool: RegisterGovernedTool;
  approve: MissionLifecycleToolDeps['approve'];
}): void {
  const common = {
    mission_id: z.string().min(1),
    tenant: z.string().optional(),
    tier: z.enum(['public', 'confidential', 'personal']).optional(),
    approval_ref: z.string().optional(),
  };
  for (const operation of MCP_MISSION_LIFECYCLE_OPERATIONS) {
    const extra =
      operation === 'record_evidence'
        ? { task_id: z.string().min(1), note: z.string().min(1) }
        : operation === 'review_task'
          ? {
              task_id: z.string().min(1),
              findings: z
                .array(
                  z.object({
                    severity: z.enum(['blocking', 'suggestion']),
                    category: z.string(),
                    description: z.string(),
                    required_action: z.string().optional(),
                    location: z.string().optional(),
                  })
                )
                .optional(),
            }
          : operation === 'verify'
            ? { result: z.enum(['verified', 'rejected']), note: z.string().min(1) }
            : {};
    params.registerGovernedTool(
      params.server,
      params.catalog,
      `kyberion.mission.${operation}`,
      `Mission-owner ${operation}; scope-bound approval required. Workers cannot mutate mission lifecycle.`,
      { ...common, ...extra },
      async (args) => {
        try {
          const context = resolveMcpRequestContext({
            requested_tenant: args.tenant,
            requested_tier: args.tier,
            mission_id: args.mission_id,
          });
          const result = await executeMcpMissionLifecycle(operation, args, context, {
            approve: params.approve,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: formatWireError(error, 'Mission lifecycle operation failed'),
              },
            ],
          };
        }
      }
    );
  }
}
