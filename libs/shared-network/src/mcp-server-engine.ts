/**
 * Kyberion MCP Server Engine (Phase 0/1 — G1/G2)
 *
 * Exposes Kyberion capabilities as an MCP server so that Cowork (and other
 * MCP clients) can call them via stdio transport.
 *
 * Tools implemented in this facade:
 *   kyberion.pipeline.list          — enumerate pipelines/
 *   kyberion.pipeline.run           — execute a pipeline via run_pipeline.js
 *   kyberion.pipeline.job_status    — poll a background pipeline job
 *   kyberion.knowledge.search       — search public knowledge tier
 *   kyberion.mission.create         — create a new mission
 *   kyberion.mission.status         — query mission status
 *   kyberion.mission.journal        — read mission journal
 *   kyberion.capability.list        — list actuator capabilities
 *   kyberion.surface.cowork.deliver — deliver artifact to Cowork outbox (Phase 1)
 *   kyberion.surface.cowork.list    — list pending Cowork outbox deliveries (Phase 1)
 *
 * Architecture rules (AGENTS.md):
 *   - All file I/O via secure-io (@agent/core)
 *   - Default MCP visibility: public tier only
 *   - No direct node:fs usage
 *   - Every pipeline run goes through the existing run_pipeline.js script
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as nodePath from 'node:path';
import { z } from 'zod';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExec,
  safeLstat,
  safeReadFile,
  safeReaddir,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { spawnManagedProcess, stopManagedProcess } from '@agent/core/managed-process';
import { assertMcpCallerRole, resolveMcpRequestContext } from '@agent/core/mcp-request-context';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import { normalizeEventScope } from '@agent/core/event-scope';
import { recordProtocolServiceLifecycle } from '@agent/core/protocol-service-lifecycle';
import { logger } from '@agent/core/core';
import { defineCatalog, getRegisteredEnvText, isRecord, nowIso } from '@agent/core/foundation';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
} from '@agent/core/approval-store';
import { resolveScopeResolution } from '@agent/core/scope-context';
import { formatWireError } from '@agent/core/wire-error';
import { runOpPreflight } from '@agent/core/op-preflight';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { buildKnowledgeIndex, queryKnowledge } from '@agent/core/src/knowledge-index';
import { recordHumanKnowledgeFeedback } from '@agent/core/knowledge-feedback-loop';
import { executeServicePreset } from '@agent/core/service-engine';
import { deliverToCowork, listCoworkOutbox } from '@agent/core/cowork-surface.js';
import {
  listPendingApprovalsForCowork,
  decideApprovalFromCowork,
  recordAuditExportRequest,
} from '@agent/core/approval-cowork-adapter.js';
import { runCoworkKnowledgeSync } from '@agent/core/cowork-knowledge-bridge.js';
import type { EventScope } from '@agent/core/event-scope';
import type { McpRequestContext } from '@agent/core/mcp-request-context';
import { parseMcpTextPayload, parseSafeJsonObject } from './mcp-json.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVER_NAME = 'kyberion-mcp-server';
const SERVER_VERSION = '0.1.0';

/** Resolve the absolute path to the Kyberion repo root. */
const REPO_ROOT = pathResolver.rootDir();

/** Path to the MCP tool catalog (allowlist). */
const CATALOG_PATH = pathResolver.knowledge('product/governance/mcp-tool-catalog.json');

/** Path to the compiled pipeline runner script. */
const PIPELINE_RUNNER = nodePath.join(REPO_ROOT, 'dist/scripts/run_pipeline.js');

/** Maximum execution time for a synchronous pipeline run via MCP (60 seconds). */
const PIPELINE_TIMEOUT_MS = 60_000;

/** Maximum execution time for a background pipeline job (30 minutes). */
const PIPELINE_JOB_TIMEOUT_MS = 30 * 60_000;

/** Cap on the retained tail of a background job's combined stdout/stderr. */
const PIPELINE_JOB_OUTPUT_TAIL_LIMIT = 64_000;

/** Path to the compiled audit export script. */
const AUDIT_EXPORT_SCRIPT = nodePath.join(REPO_ROOT, 'dist/scripts/export_audit.js');

// ─── Catalog helpers ──────────────────────────────────────────────────────────

interface ToolCatalog {
  pipeline_run_allowlist: string[];
  tools?: ToolCatalogEntry[];
}

interface ToolCatalogEntry {
  name: string;
  allowed_caller_roles?: string[];
  allowed_tiers?: string[];
  requires_approval?: boolean;
}

const mcpToolCatalog = defineCatalog<ToolCatalog>({
  id: 'mcp-tool-catalog',
  path: CATALOG_PATH,
  schema: pathResolver.knowledge('product/schemas/mcp-tool-catalog.schema.json'),
  fallback: { pipeline_run_allowlist: [], tools: [] },
  fallbackOnInvalid: true,
});

interface McpApprovalResult {
  allowed: boolean;
  request_id?: string;
  status: 'approved' | 'approval_required';
}

const APPROVAL_SCOPE_KEYS = [
  'scope_kind',
  'tier',
  'tenant_slug',
  'organization_id',
  'project_id',
  'mission_id',
  'task_id',
  'nhi_id',
] as const;

/** Tools whose handler must call ensureMcpApproval before producing an effect. */
const APPROVAL_GATED_MCP_TOOLS = new Set(['kyberion.mission.create', 'kyberion.service.actuate']);

function exactMcpApprovalScopeMatches(
  actual: EventScope | undefined,
  expected: EventScope
): boolean {
  if (!actual) return false;
  return APPROVAL_SCOPE_KEYS.every((key) => actual[key] === expected[key]);
}

function ensureMcpApproval(params: {
  context: McpRequestContext;
  approvalRef?: string;
  payload: Record<string, unknown>;
  effectBinding: string;
  title: string;
  summary: string;
  details: string;
}): McpApprovalResult {
  const payloadHash = computeApprovalPayloadHash(params.payload);
  const approvalChannel = 'mcp-approval';
  const correlationId = `mcp:${params.effectBinding}:${payloadHash}`;

  if (!params.approvalRef) {
    const existing = listApprovalRequests({
      storageChannels: [approvalChannel],
      status: 'pending',
      scope: params.context.scope,
    }).find(
      (request) =>
        request.correlationId === correlationId &&
        request.accountability?.payloadHash === payloadHash &&
        request.accountability?.effectBinding === params.effectBinding
    );
    const record =
      existing ||
      createApprovalRequest('surface_runtime', {
        channel: approvalChannel,
        storageChannel: approvalChannel,
        threadTs: correlationId,
        correlationId,
        requestedBy: params.context.principal,
        draft: {
          title: params.title,
          summary: params.summary,
          details: params.details,
          severity: 'high',
        },
        requestedByContext: {
          surface: 'api',
          actorId: params.context.principal,
          actorRole: params.context.caller_role,
        },
        justification: {
          reason: 'MCP tool catalog marks this operation as requiring human approval.',
          requestedEffects: [params.effectBinding],
        },
        risk: { level: 'high', restartScope: 'service', requiresStrongAuth: true },
        accountability: {
          finalDecision: 'human_only',
          payloadHash,
          effectBinding: params.effectBinding,
        },
        scope: params.context.scope,
      });
    return { allowed: false, request_id: record.id, status: 'approval_required' };
  }

  const approval = loadApprovalRequest(approvalChannel, params.approvalRef);
  if (!approval) {
    throw new Error(`[MCP_APPROVAL_NOT_FOUND] approval '${params.approvalRef}' was not found`);
  }
  if (approval.status !== 'approved') {
    throw new Error(
      `[MCP_APPROVAL_REQUIRED] approval '${params.approvalRef}' is '${approval.status}', not approved`
    );
  }
  if (!exactMcpApprovalScopeMatches(approval.scope, params.context.scope)) {
    throw new Error('[MCP_APPROVAL_SCOPE_MISMATCH] approval scope does not match request scope');
  }
  if (approval.accountability?.payloadHash !== payloadHash) {
    throw new Error('[MCP_APPROVAL_PAYLOAD_MISMATCH] approval payload does not match request');
  }
  if (approval.accountability?.effectBinding !== params.effectBinding) {
    throw new Error('[MCP_APPROVAL_EFFECT_MISMATCH] approval effect does not match request');
  }
  return { allowed: true, status: 'approved' };
}

function loadCatalog(): ToolCatalog {
  return mcpToolCatalog.load();
}

function catalogEntry(catalog: ToolCatalog, toolName: string): ToolCatalogEntry {
  const entry = catalog.tools?.find((tool) => tool.name === toolName);
  if (!entry || !entry.allowed_caller_roles?.length || !entry.allowed_tiers?.length) {
    throw new Error(`[MCP_TOOL_UNREGISTERED] tool '${toolName}' has no governed catalog entry`);
  }
  if (entry.requires_approval === true && !APPROVAL_GATED_MCP_TOOLS.has(toolName)) {
    throw new Error(
      `[MCP_APPROVAL_GATE_MISSING] tool '${toolName}' declares requires_approval but has no approval gate`
    );
  }
  return entry;
}

interface McpStructuredError {
  message: string;
}

interface McpStructuredContent {
  ok: boolean;
  data?: unknown;
  error?: McpStructuredError;
}

const MCP_STRUCTURED_OUTPUT_SCHEMA = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
};

type McpToolInputSchema = NonNullable<Parameters<McpServer['registerTool']>[1]['inputSchema']>;

/**
 * Keep legacy text content stable while exposing one machine-readable result
 * shape to MCP clients. Handlers historically returned either JSON text or
 * raw command output, so the adapter deliberately normalizes at the wire
 * boundary instead of forcing every domain handler to share serialization
 * details.
 */
function withMcpStructuredContent(result: unknown): CallToolResult {
  const resultRecord = isRecord(result) ? result : {};
  if (resultRecord.structuredContent) return result as unknown as CallToolResult;

  const textItem = Array.isArray(resultRecord.content)
    ? resultRecord.content.find(
        (item): item is Record<string, unknown> =>
          isRecord(item) && item.type === 'text' && typeof item.text === 'string'
      )
    : undefined;
  const text = typeof textItem?.text === 'string' ? textItem.text : '';
  const structuredContent: McpStructuredContent = resultRecord.isError
    ? { ok: false, error: { message: text } }
    : { ok: true, data: parseMcpTextPayload(text) };

  return { ...resultRecord, structuredContent } as unknown as CallToolResult;
}

function registerGovernedTool(
  server: McpServer,
  catalog: ToolCatalog,
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<any>
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema as McpToolInputSchema,
      outputSchema: MCP_STRUCTURED_OUTPUT_SCHEMA,
    },
    async (args: any) => {
      try {
        ensureDefaultOpPreflight();
        const entry = catalogEntry(catalog, name);
        const context = resolveMcpRequestContext({
          requested_tenant: typeof args?.tenant === 'string' ? args.tenant : undefined,
          requested_tier:
            args?.tier === 'public' || args?.tier === 'confidential' || args?.tier === 'personal'
              ? args.tier
              : undefined,
          mission_id: typeof args?.mission_id === 'string' ? args.mission_id : undefined,
          task_id: typeof args?.task_id === 'string' ? args.task_id : undefined,
        });
        const requestedTier =
          args?.tier === 'public' || args?.tier === 'confidential' || args?.tier === 'personal'
            ? args.tier
            : undefined;
        if (requestedTier && !entry.allowed_tiers!.includes(requestedTier)) {
          throw new Error(`[MCP_TIER_DENIED] tier '${requestedTier}' is not allowed for ${name}`);
        }
        assertMcpCallerRole(context, entry.allowed_caller_roles!, name);
        const preflight = await runOpPreflight({
          op: name,
          params: args as Record<string, unknown>,
          context: context as unknown as Record<string, unknown>,
          source: 'mcp',
          // Approval-gated MCP tools perform their scope-bound approval check
          // inside the handler; do not duplicate that check before its payload
          // hash and exact scope are available.
          requiresApproval: entry.requires_approval === true,
          approvalGranted: entry.requires_approval === true,
        });
        if (preflight.decision !== 'allow') {
          return withMcpStructuredContent({
            content: [
              {
                type: 'text' as const,
                text: formatWireError(
                  new Error(preflight.reason || `MCP operation ${name} was not admitted`),
                  'MCP operation blocked'
                ),
              },
            ],
            isError: true,
          });
        }
        return withMcpStructuredContent(await handler(preflight.input));
      } catch (err) {
        return withMcpStructuredContent({
          content: [
            { type: 'text' as const, text: formatWireError(err, 'MCP tool request failed') },
          ],
          isError: true,
        });
      }
    }
  );
}

function isPipelineAllowed(inputPath: string, catalog: ToolCatalog): boolean {
  const normalised = inputPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return catalog.pipeline_run_allowlist.some((p) => p.replace(/^\.\//, '') === normalised);
}

function resolveRegularRepositoryFile(filePath: string, label: string): string {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`${label} must be an existing regular file: ${filePath}`);
  }
  return safePath;
}

function tryResolveRegularRepositoryFile(filePath: string): string | null {
  try {
    return resolveRegularRepositoryFile(filePath, 'Resource');
  } catch {
    return null;
  }
}

function auditExportScriptUnavailable() {
  return {
    content: [
      { type: 'text' as const, text: 'Audit export script not built. Run pnpm build first.' },
    ],
    isError: true as const,
  };
}
// ─── Tool implementations ─────────────────────────────────────────────────────

interface PipelineListEntry {
  name: string;
  path: string;
  description: string;
  /** Same predicate pipeline.run enforces: entries with false are visible but not runnable via MCP. */
  runnable_via_mcp: boolean;
}

function listPipelines(catalog: ToolCatalog): PipelineListEntry[] {
  const pipelinesDir = nodePath.join(REPO_ROOT, 'pipelines');
  if (!safeExistsSync(pipelinesDir)) return [];

  const entries = safeReaddir(pipelinesDir);
  const results: PipelineListEntry[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const fullPath = nodePath.join(pipelinesDir, entry);
    const relPath = `pipelines/${entry}`;
    const runnable = isPipelineAllowed(relPath, catalog);
    try {
      const safePath = resolveRegularRepositoryFile(fullPath, `Pipeline '${relPath}'`);
      const raw = safeReadFile(safePath, { encoding: 'utf8' }) as string;
      const parsed = parseSafeJsonObject(raw);
      if (!parsed) throw new Error(`Invalid pipeline metadata: ${relPath}`);
      results.push({
        name:
          typeof parsed.pipeline_id === 'string' ? parsed.pipeline_id : entry.replace('.json', ''),
        path: relPath,
        description: typeof parsed.description === 'string' ? parsed.description : '',
        runnable_via_mcp: runnable,
      });
    } catch {
      results.push({
        name: entry.replace('.json', ''),
        path: relPath,
        description: '',
        runnable_via_mcp: runnable,
      });
    }
  }

  return results;
}
// ─── Background pipeline jobs ─────────────────────────────────────────────────
//
// Long pipelines exceed the 60s synchronous window, so pipeline.run can start
// them as supervised background jobs instead. Jobs are children of this MCP
// server process (runtime-supervisor cleanup kills them if the server exits),
// and their records live in memory for the server's lifetime.

interface PipelineJob {
  job_id: string;
  input: string;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out';
  started_at: string;
  finished_at?: string;
  exit_code?: number | null;
  pid?: number;
  output_tail: string;
}

const pipelineJobs = new Map<string, PipelineJob>();
function startPipelineJob(input: string, absInput: string, extraArgs: string[]): PipelineJob {
  const jobId = `plj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const resourceId = `mcp-pipeline-job:${jobId}`;
  const job: PipelineJob = {
    job_id: jobId,
    input,
    status: 'running',
    started_at: nowIso(),
    output_tail: '',
  };
  pipelineJobs.set(jobId, job);

  const appendOutput = (chunk: unknown) => {
    job.output_tail = (job.output_tail + String(chunk)).slice(-PIPELINE_JOB_OUTPUT_TAIL_LIMIT);
  };

  const { child } = spawnManagedProcess({
    resourceId,
    kind: 'service',
    ownerId: SERVER_NAME,
    ownerType: 'mcp-server',
    command: 'node',
    args: [PIPELINE_RUNNER, '--input', absInput, ...extraArgs],
    spawnOptions: { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    metadata: { job_id: jobId, pipeline_input: input },
  });
  job.pid = child.pid;
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);

  const timeout = setTimeout(() => {
    if (job.status === 'running') {
      job.status = 'timed_out';
      job.finished_at = nowIso();
      stopManagedProcess(resourceId, child);
    }
  }, PIPELINE_JOB_TIMEOUT_MS);
  timeout.unref?.();

  child.on('error', (err) => {
    clearTimeout(timeout);
    if (job.status === 'running') {
      job.status = 'failed';
      job.finished_at = nowIso();
      appendOutput(`\n[job] spawn error: ${err}`);
    }
    stopManagedProcess(resourceId, null);
  });
  child.on('exit', (code) => {
    clearTimeout(timeout);
    if (job.status === 'running') {
      job.exit_code = code;
      job.status = code === 0 ? 'succeeded' : 'failed';
      job.finished_at = nowIso();
    }
    stopManagedProcess(resourceId, null);
  });

  return job;
}

function describePipelineJob(job: PipelineJob): Record<string, unknown> {
  return {
    job_id: job.job_id,
    input: job.input,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at ?? null,
    exit_code: job.exit_code ?? null,
    output_tail: job.output_tail,
  };
}

async function searchKnowledge(
  query: string,
  maxResults: number
): Promise<{ topic: string; hint: string; source: string; confidence: number }[]> {
  const index = await buildKnowledgeIndex();
  const results = await queryKnowledge(index, query, { maxResults });
  return results.map((r) => ({
    topic: r.topic,
    hint: r.hint,
    source: r.source,
    confidence: r.confidence,
  }));
}

function listCapabilities(): { actuator: string; ops: string[] }[] {
  const actuatorsDir = nodePath.join(REPO_ROOT, 'libs/actuators');
  if (!safeExistsSync(actuatorsDir)) return [];

  const results: { actuator: string; ops: string[] }[] = [];

  let dirs: string[];
  try {
    dirs = safeReaddir(actuatorsDir);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    let manifestPath: string;
    try {
      manifestPath = resolveRegularRepositoryFile(
        nodePath.join(actuatorsDir, dir, 'manifest.json'),
        `Actuator '${dir}' manifest`
      );
      const raw = safeReadFile(manifestPath, { encoding: 'utf8' }) as string;
      const manifest = parseSafeJsonObject(raw);
      if (!manifest) throw new Error(`Invalid actuator manifest: ${dir}`);
      const capabilities = Array.isArray(manifest.capabilities)
        ? manifest.capabilities.filter(
            (capability): capability is Record<string, unknown> =>
              isRecord(capability) && typeof capability.op === 'string'
          )
        : [];
      results.push({
        actuator: typeof manifest.actuator_id === 'string' ? manifest.actuator_id : dir,
        ops: capabilities.map((capability) => capability.op as string),
      });
    } catch {
      results.push({ actuator: dir, ops: [] });
    }
  }

  return results;
}
function searchCapabilities(
  query: string,
  maxResults: number
): { actuator: string; ops: string[] }[] {
  const normalizedQuery = String(query || '')
    .trim()
    .toLowerCase();
  if (!normalizedQuery) return [];
  return listCapabilities()
    .filter((capability) => {
      const haystack = `${capability.actuator} ${capability.ops.join(' ')}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .slice(0, Math.max(1, Math.min(20, Math.floor(maxResults) || 5)));
}

function getMissionStatus(missionId: string, tenant: string): string {
  return safeExec(
    'node',
    [
      nodePath.join(REPO_ROOT, 'dist/scripts/mission_controller.js'),
      'status',
      '--mission-id',
      missionId,
      '--tenant-slug',
      tenant,
    ],
    {
      cwd: REPO_ROOT,
      timeoutMs: 15_000,
      maxOutputMB: 2,
    }
  );
}

function getMissionJournal(missionId: string, tenant: string): string {
  return safeExec(
    'node',
    [
      nodePath.join(REPO_ROOT, 'dist/scripts/mission_journal.js'),
      '--mission-id',
      missionId,
      '--tenant-slug',
      tenant,
    ],
    {
      cwd: REPO_ROOT,
      timeoutMs: 15_000,
      maxOutputMB: 2,
    }
  );
}

function createMission(brief: string, title: string, tenant: string): string {
  return safeExec(
    'node',
    [
      nodePath.join(REPO_ROOT, 'dist/scripts/mission_controller.js'),
      'create',
      '--brief',
      brief,
      '--title',
      title,
      '--tenant-slug',
      tenant,
    ],
    {
      cwd: REPO_ROOT,
      timeoutMs: 30_000,
      maxOutputMB: 2,
    }
  );
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function createKyberionMcpServer(): McpServer {
  assertProtocolServiceRegistered('mcp-server-cowork');
  const catalog = loadCatalog();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        'This is the Kyberion MCP server. It exposes Kyberion pipeline, mission,',
        'knowledge, and capability tools. All operations are governed by the',
        'Kyberion security model (3-tier knowledge isolation, audit chain).',
        'Use kyberion.pipeline.list to discover available pipelines before running one.',
      ].join(' '),
    }
  );

  // ── kyberion.pipeline.list ────────────────────────────────────────────────
  // ── kyberion.scope.current ────────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.scope.current',
    'Resolve the effective Kyberion scope, its provenance, and the positive knowledge roots available to this process.',
    {},
    async () => {
      const context = resolveMcpRequestContext();
      const scopeInput = {
        tier: context.scope.tier,
        ...(context.scope.tenant_slug ? { tenant_slug: context.scope.tenant_slug } : {}),
        ...(context.scope.organization_id
          ? { organization_id: context.scope.organization_id }
          : {}),
        ...(context.scope.project_id ? { project_id: context.scope.project_id } : {}),
        ...(context.scope.mission_id ? { mission_id: context.scope.mission_id } : {}),
        ...(context.scope.task_id ? { task_id: context.scope.task_id } : {}),
      };
      const resolution = resolveScopeResolution(
        scopeInput,
        {
          KYBERION_TIER: context.scope.tier,
          KYBERION_TENANT: context.scope.tenant_slug,
          KYBERION_ORGANIZATION_ID: context.scope.organization_id,
          KYBERION_PROJECT_ID: context.scope.project_id,
          MISSION_ID: context.scope.mission_id,
          KYBERION_TASK_ID: context.scope.task_id,
        },
        { includePersisted: false, inferFromMission: false, inferFromCwd: false }
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(resolution, null, 2) }],
      };
    }
  );

  // ── kyberion.knowledge.feedback ──────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.knowledge.feedback',
    'Record human feedback for a knowledge document in the current tenant scope.',
    {
      document_path: z.string().describe('Repo-relative knowledge document path'),
      verdict: z.enum(['useful', 'stale', 'wrong', 'not_useful']),
      reason: z.string().optional(),
    },
    async ({ document_path, verdict, reason }) => {
      const context = resolveMcpRequestContext();
      const feedbackPath = recordHumanKnowledgeFeedback({
        document_path,
        verdict,
        reason,
        actor: context.principal,
        source: 'mcp',
        scope: context.scope,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'recorded', feedback_path: feedbackPath }, null, 2),
          },
        ],
      };
    }
  );

  // ── kyberion.pipeline.list ────────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.pipeline.list',
    'List Kyberion pipeline definitions. Each entry carries `runnable_via_mcp`; ' +
      'only entries with `runnable_via_mcp: true` can be executed with kyberion.pipeline.run.',
    {},
    async () => {
      try {
        const pipelines = listPipelines(catalog);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(pipelines, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Error listing pipelines') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.pipeline.run ─────────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.pipeline.run',
    'Execute a Kyberion pipeline. Only allowlisted pipelines may be run via MCP. ' +
      'Synchronous runs are killed after 60s; pass background: true for long pipelines ' +
      'and poll kyberion.pipeline.job_status with the returned job_id.',
    {
      input: z
        .string()
        .describe('Relative path to the pipeline JSON, e.g. "pipelines/vital-check.json"'),
      vars: z
        .record(z.string(), z.string())
        .optional()
        .describe('Optional template variable overrides'),
      background: z
        .boolean()
        .optional()
        .default(false)
        .describe('Run as a background job (for pipelines longer than the 60s sync window)'),
    },
    async ({ input, vars, background }) => {
      if (!isPipelineAllowed(input, catalog)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Pipeline '${input}' is not on the MCP allowlist. ` +
                'Use kyberion.pipeline.list and pick an entry with runnable_via_mcp: true ' +
                '(allowlist source: knowledge/product/governance/mcp-tool-catalog.json).',
            },
          ],
          isError: true,
        };
      }
      try {
        const extraArgs: string[] = [];
        if (vars && Object.keys(vars).length > 0) {
          extraArgs.push('--vars', JSON.stringify(vars));
        }
        const absInput = nodePath.isAbsolute(input) ? input : nodePath.join(REPO_ROOT, input);
        let safeInput: string;
        try {
          safeInput = resolveRegularRepositoryFile(absInput, 'Pipeline file');
        } catch (error) {
          if (!safeExistsSync(absInput)) {
            return {
              content: [{ type: 'text' as const, text: `Pipeline file not found: ${input}` }],
              isError: true,
            };
          }
          throw error;
        }
        let safeRunner: string;
        try {
          safeRunner = resolveRegularRepositoryFile(PIPELINE_RUNNER, 'Pipeline runner');
        } catch {
          return {
            content: [
              { type: 'text' as const, text: 'Pipeline runner not built. Run pnpm build first.' },
            ],
            isError: true,
          };
        }
        if (background) {
          const job = startPipelineJob(input, safeInput, extraArgs);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    job_id: job.job_id,
                    status: job.status,
                    poll_with: 'kyberion.pipeline.job_status',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const output = safeExec('node', [safeRunner, '--input', safeInput, ...extraArgs], {
          cwd: REPO_ROOT,
          timeoutMs: PIPELINE_TIMEOUT_MS,
          maxOutputMB: 5,
        });
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Pipeline execution failed') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.pipeline.job_status ──────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.pipeline.job_status',
    'Check a background pipeline job started with kyberion.pipeline.run background: true. ' +
      'Returns status, exit code, and the tail of the combined output.',
    {
      job_id: z.string().describe('Job id returned by kyberion.pipeline.run'),
    },
    async ({ job_id }) => {
      const job = pipelineJobs.get(job_id);
      if (!job) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unknown pipeline job '${job_id}'. Jobs live for this MCP server session only.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(describePipelineJob(job), null, 2),
          },
        ],
        ...(job.status === 'failed' || job.status === 'timed_out' ? { isError: true } : {}),
      };
    }
  );

  // ── kyberion.knowledge.search ─────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.knowledge.search',
    'Search the Kyberion knowledge base (public tier). Returns ranked hints.',
    {
      query: z.string().describe('Search query'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe('Maximum number of results to return (default: 5)'),
    },
    async ({ query, max_results }) => {
      try {
        const results = await searchKnowledge(query, max_results ?? 5);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Knowledge search failed') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.capability.list ──────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.capability.list',
    'List all available Kyberion actuator capabilities.',
    {},
    async () => {
      try {
        const capabilities = listCapabilities();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(capabilities, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Failed to list capabilities') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.capability.search (PI-17 deferred tool discovery) ────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.capability.search',
    'Search governed actuator capability descriptions before loading an additional tool surface.',
    {
      query: z.string().min(1).describe('Capability or operation to search for'),
      max_results: z.number().int().min(1).max(20).optional().default(5),
    },
    async ({ query, max_results }) => {
      try {
        const results = searchCapabilities(query, max_results ?? 5);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Failed to search capabilities') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.service.actuate ──────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.service.actuate',
    'Execute a Kyberion service actuator (e.g. Notion API) operation.',
    {
      service_id: z.string().describe('The ID of the service (e.g. "notion")'),
      action: z.string().describe('The operation to execute (e.g. "search", "retrieve_page")'),
      params: z
        .record(z.string(), z.any())
        .optional()
        .describe('Parameters for the operation (payload/query string)'),
      approval_ref: z
        .string()
        .optional()
        .describe('Approved request_id from kyberion.approval.list_pending'),
    },
    async ({ service_id, action, params, approval_ref }) => {
      try {
        const context = resolveMcpRequestContext({ require_tenant: true });
        if (getRegisteredEnvText('KYBERION_ENABLE_SERVICE_ACTUATE_TOOL') !== '1') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Service actuate tool is disabled. Set KYBERION_ENABLE_SERVICE_ACTUATE_TOOL=1 to enable it for trusted operators.',
              },
            ],
            isError: true,
          };
        }
        const approval = ensureMcpApproval({
          context,
          approvalRef: approval_ref,
          payload: { operation: 'service.actuate', service_id, action, params: params ?? {} },
          effectBinding: `service.actuate:${service_id}:${action}`,
          title: `Execute service '${service_id}' action '${action}'`,
          summary: `MCP caller '${context.principal}' requested a service actuator operation.`,
          details: JSON.stringify(params ?? {}),
        });
        if (!approval.allowed) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { status: approval.status, request_id: approval.request_id },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const result = await executeServicePreset(service_id, action, params ?? {}, 'secret-guard');
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Service actuate failed') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.mission.create ───────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.mission.create',
    'Create a new Kyberion mission. Returns the mission ID.',
    {
      title: z.string().describe('Short mission title'),
      brief: z.string().describe('Mission brief — describe the goal in plain language'),
      tenant: z.string().describe('Server-bound tenant slug for the mission'),
      approval_ref: z
        .string()
        .optional()
        .describe('Approved request_id from kyberion.approval.list_pending'),
    },
    async ({ title, brief, tenant, approval_ref }) => {
      try {
        const context = resolveMcpRequestContext({
          requested_tenant: tenant,
          require_tenant: true,
        });
        const approval = ensureMcpApproval({
          context,
          approvalRef: approval_ref,
          payload: { operation: 'mission.create', title, brief, tenant },
          effectBinding: `mission.create:${tenant}`,
          title: `Create mission in tenant '${tenant}'`,
          summary: `MCP caller '${context.principal}' requested creation of mission '${title}'.`,
          details: brief,
        });
        if (!approval.allowed) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { status: approval.status, request_id: approval.request_id },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const output = createMission(brief, title, context.scope.tenant_slug!);
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Mission creation failed') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.mission.status ───────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.mission.status',
    'Get the current status of a Kyberion mission.',
    {
      mission_id: z.string().describe('The mission ID to query'),
      tenant: z.string().describe('Server-bound tenant slug for the mission'),
    },
    async ({ mission_id, tenant }) => {
      try {
        const context = resolveMcpRequestContext({
          requested_tenant: tenant,
          require_tenant: true,
          mission_id,
        });
        const output = getMissionStatus(mission_id, context.scope.tenant_slug!);
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Mission status query failed') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.mission.journal ──────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.mission.journal',
    'Read the journal log of a Kyberion mission.',
    {
      mission_id: z.string().describe('The mission ID whose journal to read'),
      tenant: z.string().describe('Server-bound tenant slug for the mission'),
    },
    async ({ mission_id, tenant }) => {
      try {
        const context = resolveMcpRequestContext({
          requested_tenant: tenant,
          require_tenant: true,
          mission_id,
        });
        const output = getMissionJournal(mission_id, context.scope.tenant_slug!);
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Mission journal read failed') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.surface.cowork.deliver ──────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.surface.cowork.deliver',
    'Deliver a Kyberion result artifact to the Cowork outbox. Cowork can then present it to the operator.',
    {
      title: z.string().describe('Title of the result'),
      summary: z.string().describe('Short summary of what was produced (shown in Cowork)'),
      content: z.string().describe('Full artifact content'),
      content_type: z
        .string()
        .optional()
        .default('text/plain')
        .describe('MIME type of the content'),
      mission_id: z.string().optional().describe('Mission ID that produced this artifact'),
      trace_id: z.string().optional().describe('Pipeline trace ID'),
      next_action: z.string().optional().describe('Suggested next action for the operator'),
      intent_resolution: z
        .object({
          request_id: z.string(),
          normalized_intent: z.string(),
          missing_inputs: z.array(z.string()),
          resolution_shape: z.enum([
            'direct_answer',
            'task_session',
            'mission',
            'project_bootstrap',
          ]),
          outcome_kind: z.enum([
            'answer',
            'artifact',
            'approval_ready_plan',
            'service_change',
            'status_report',
          ]),
          authority_level: z.enum([
            'autonomous',
            'approval_required',
            'human_clarification_required',
          ]),
          next_action: z.object({
            kind: z.enum(['request_approval', 'provide_input', 'continue']),
            label: z.string(),
            consequence: z.string(),
          }),
          project_context: z
            .object({ project_id: z.string().optional(), confidence: z.number() })
            .optional(),
          rationale: z.string(),
        })
        .optional()
        .describe('Structured intent-resolution explanation for the Cowork operator'),
    },
    async ({
      title,
      summary,
      content,
      content_type,
      mission_id,
      trace_id,
      next_action,
      intent_resolution,
    }) => {
      try {
        const deliveryId = deliverToCowork(
          [{ content, content_type: content_type ?? 'text/plain', description: title }],
          {
            title,
            summary,
            missionId: mission_id,
            traceId: trace_id,
            nextAction: next_action,
            intentResolution: intent_resolution,
          }
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ delivery_id: deliveryId, status: 'delivered' }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Cowork delivery failed') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.surface.cowork.list ──────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.surface.cowork.list',
    'List pending artifact deliveries in the Cowork outbox.',
    {},
    async () => {
      try {
        const packets = listCoworkOutbox();
        return { content: [{ type: 'text' as const, text: JSON.stringify(packets, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Failed to list Cowork outbox') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.knowledge.cowork_sync ───────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.knowledge.cowork_sync',
    [
      'Sync Kyberion knowledge with Cowork workspace.',
      'direction=kyberion-to-cowork: supply public knowledge hints to Cowork outbox.',
      'direction=cowork-to-kyberion: ingest Cowork artifact paths into the memory-promotion-queue.',
      'direction=both (default): run both directions.',
    ].join(' '),
    {
      direction: z
        .enum(['cowork-to-kyberion', 'kyberion-to-cowork', 'both'])
        .optional()
        .default('both')
        .describe('Sync direction'),
      cowork_artifact_paths: z
        .array(z.string())
        .optional()
        .default([])
        .describe('Paths to Cowork artifacts to ingest (for cowork-to-kyberion direction)'),
      max_hints: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe('Max number of knowledge hints to supply to Cowork (default: 50)'),
    },
    async ({ direction, cowork_artifact_paths, max_hints }) => {
      try {
        const context = resolveMcpRequestContext();
        const result = runCoworkKnowledgeSync({
          direction: direction ?? 'both',
          coworkArtifactPaths: cowork_artifact_paths ?? [],
          maxHints: max_hints ?? 50,
          ...(context.scope.tenant_slug ? { scope: context.scope } : {}),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatWireError(err, 'Knowledge sync failed') }],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.approval.list_pending ────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.approval.list_pending',
    'List all pending Kyberion approval requests. Call this before kyberion.approval.decide.',
    {},
    async () => {
      try {
        const context = resolveMcpRequestContext();
        const scope = context.scope.tenant_slug
          ? { tenant_slug: context.scope.tenant_slug, tier: context.scope.tier }
          : undefined;
        const pending = listPendingApprovalsForCowork(scope);
        return { content: [{ type: 'text' as const, text: JSON.stringify(pending, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatWireError(err, 'Failed to list pending approvals'),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.approval.decide ──────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.approval.decide',
    [
      'Submit an approval decision (approved/rejected) for a pending Kyberion request.',
      'IMPORTANT: You MUST call kyberion.approval.list_pending first to obtain a valid request_id.',
      'This is a two-step operation — blind approval without listing first will be rejected.',
    ].join(' '),
    {
      request_id: z
        .string()
        .describe('The request_id obtained from kyberion.approval.list_pending'),
      decision: z.enum(['approved', 'rejected']).describe('The decision to apply'),
      decided_by: z.string().describe('Identity of the operator submitting the decision'),
      note: z.string().optional().describe('Optional rationale or note for the decision'),
    },
    async ({ request_id, decision, decided_by, note }) => {
      try {
        const context = resolveMcpRequestContext();
        const scope = context.scope.tenant_slug
          ? { tenant_slug: context.scope.tenant_slug, tier: context.scope.tier }
          : undefined;
        const result = decideApprovalFromCowork({
          requestId: request_id,
          decision,
          decidedBy: decided_by,
          note,
          scope,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Approval decision failed') },
          ],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.audit.export ─────────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.audit.export',
    'Export the Kyberion audit chain log. Returns a path to the exported NDJSON bundle.',
    {
      from: z.string().optional().describe('Start date filter YYYY-MM-DD'),
      to: z.string().optional().describe('End date filter YYYY-MM-DD'),
      tenant: z.string().optional().describe('Filter by tenant slug'),
      requested_by: z
        .string()
        .optional()
        .default('cowork-operator')
        .describe('Identity requesting the export'),
    },
    async ({ from, to, tenant, requested_by }) => {
      try {
        const context = resolveMcpRequestContext({ requested_tenant: tenant });
        const effectiveTenant = context.scope.tenant_slug;
        recordAuditExportRequest({
          requestedBy: requested_by ?? 'cowork-operator',
          from,
          to,
          verifyOnly: false,
        });
        const auditExportScript = tryResolveRegularRepositoryFile(AUDIT_EXPORT_SCRIPT);
        if (!auditExportScript) return auditExportScriptUnavailable();
        const args = [auditExportScript];
        if (from) args.push('--from', from);
        if (to) args.push('--to', to);
        if (effectiveTenant) args.push('--tenant', effectiveTenant);
        const output = safeExec('node', args, {
          cwd: REPO_ROOT,
          timeoutMs: 30_000,
          maxOutputMB: 10,
        });
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatWireError(err, 'Audit export failed') }],
          isError: true,
        };
      }
    }
  );

  // ── kyberion.audit.verify ─────────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.audit.verify',
    'Verify the integrity of the Kyberion audit chain (hash chain validation). Returns pass/fail.',
    {
      tenant: z.string().optional().describe('Scope verification to a specific tenant slug'),
      requested_by: z
        .string()
        .optional()
        .default('cowork-operator')
        .describe('Identity requesting verification'),
    },
    async ({ tenant, requested_by }) => {
      try {
        const context = resolveMcpRequestContext({ requested_tenant: tenant });
        const effectiveTenant = context.scope.tenant_slug;
        recordAuditExportRequest({
          requestedBy: requested_by ?? 'cowork-operator',
          verifyOnly: true,
        });
        const auditExportScript = tryResolveRegularRepositoryFile(AUDIT_EXPORT_SCRIPT);
        if (!auditExportScript) return auditExportScriptUnavailable();
        const args = [auditExportScript, '--verify-only'];
        if (effectiveTenant) args.push('--tenant', effectiveTenant);
        const output = safeExec('node', args, {
          cwd: REPO_ROOT,
          timeoutMs: 30_000,
          maxOutputMB: 5,
        });
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Audit verification failed') },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ─── Transport helpers ────────────────────────────────────────────────────────

/**
 * Connect the server to a stdio transport and begin listening.
 * Called by scripts/mcp_server.ts.
 */
export async function startMcpServerStdio(): Promise<void> {
  const server = createKyberionMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const tenant = String(
    getRegisteredEnvText('KYBERION_TENANT') || getRegisteredEnvText('KYBERION_TENANT_ID') || ''
  ).trim();
  const scope = normalizeEventScope(
    tenant
      ? { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant }
      : { scope_kind: 'system', tier: 'public' }
  );
  const principalId =
    String(
      getRegisteredEnvText('KYBERION_MCP_NHI') ||
        getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
        ''
    ).trim() || 'mcp-server-cowork';
  try {
    recordProtocolServiceLifecycle({
      serviceId: 'mcp-server-cowork',
      action: 'start',
      status: 'started',
      scope,
      actorRole: 'surface_runtime',
      principal: { kind: 'service', id: principalId },
      requestedBy: principalId,
    });
  } catch (error) {
    await transport.close();
    throw error;
  }
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      recordProtocolServiceLifecycle({
        serviceId: 'mcp-server-cowork',
        action: 'stop',
        status: 'stopped',
        scope,
        actorRole: 'surface_runtime',
        principal: { kind: 'service', id: principalId },
        requestedBy: principalId,
      });
    } catch (error) {
      logger.error(`[MCP] stop lifecycle receipt unavailable: ${error}`);
    } finally {
      await transport.close();
    }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
