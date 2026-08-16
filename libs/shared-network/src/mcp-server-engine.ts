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
import * as nodePath from 'node:path';
import { z } from 'zod';
import {
  safeReadFile,
  safeReaddir,
  safeExistsSync,
  safeExec,
  pathResolver,
  spawnManagedProcess,
  stopManagedProcess,
  resolveMcpRequestContext,
  assertMcpCallerRole,
  assertProtocolServiceRegistered,
  normalizeEventScope,
  recordProtocolServiceLifecycle,
  computeApprovalPayloadHash,
  createApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
} from '@agent/core';
import { buildKnowledgeIndex, queryKnowledge, executeServicePreset } from '@agent/core';
import { deliverToCowork, listCoworkOutbox } from '@agent/core/cowork-surface.js';
import {
  listPendingApprovalsForCowork,
  decideApprovalFromCowork,
  recordAuditExportRequest,
} from '@agent/core/approval-cowork-adapter.js';
import { runCoworkKnowledgeSync } from '@agent/core/cowork-knowledge-bridge.js';
import type { EventScope, McpRequestContext } from '@agent/core';

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVER_NAME = 'kyberion-mcp-server';
const SERVER_VERSION = '0.1.0';

/** Resolve the absolute path to the Kyberion repo root. */
const REPO_ROOT = pathResolver.rootDir();

/** Path to the MCP tool catalog (allowlist). */
const CATALOG_PATH = nodePath.join(REPO_ROOT, 'knowledge/product/governance/mcp-tool-catalog.json');

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
  try {
    const raw = safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string;
    return JSON.parse(raw) as ToolCatalog;
  } catch {
    return { pipeline_run_allowlist: [] };
  }
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

function registerGovernedTool(
  server: McpServer,
  catalog: ToolCatalog,
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<any>
): void {
  server.tool(name, description, schema, async (args: any) => {
    try {
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
      return await handler(args);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `MCP tool access denied: ${err}` }],
        isError: true,
      };
    }
  });
}

function isPipelineAllowed(inputPath: string, catalog: ToolCatalog): boolean {
  const normalised = inputPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return catalog.pipeline_run_allowlist.some((p) => p.replace(/^\.\//, '') === normalised);
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
      const raw = safeReadFile(fullPath, { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(raw);
      results.push({
        name: parsed.pipeline_id ?? entry.replace('.json', ''),
        path: relPath,
        description: parsed.description ?? '',
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
    started_at: new Date().toISOString(),
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
      job.finished_at = new Date().toISOString();
      stopManagedProcess(resourceId, child);
    }
  }, PIPELINE_JOB_TIMEOUT_MS);
  timeout.unref?.();

  child.on('error', (err) => {
    clearTimeout(timeout);
    if (job.status === 'running') {
      job.status = 'failed';
      job.finished_at = new Date().toISOString();
      appendOutput(`\n[job] spawn error: ${err}`);
    }
    stopManagedProcess(resourceId, null);
  });
  child.on('exit', (code) => {
    clearTimeout(timeout);
    if (job.status === 'running') {
      job.exit_code = code;
      job.status = code === 0 ? 'succeeded' : 'failed';
      job.finished_at = new Date().toISOString();
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
    const manifestPath = nodePath.join(actuatorsDir, dir, 'manifest.json');
    if (!safeExistsSync(manifestPath)) continue;
    try {
      const raw = safeReadFile(manifestPath, { encoding: 'utf8' }) as string;
      const manifest = JSON.parse(raw);
      results.push({
        actuator: manifest.actuator_id ?? dir,
        ops: (manifest.capabilities ?? []).map((c: { op: string }) => c.op),
      });
    } catch {
      results.push({ actuator: dir, ops: [] });
    }
  }

  return results;
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
          content: [{ type: 'text' as const, text: `Error listing pipelines: ${err}` }],
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
        if (!safeExistsSync(absInput)) {
          return {
            content: [{ type: 'text' as const, text: `Pipeline file not found: ${input}` }],
            isError: true,
          };
        }
        if (!safeExistsSync(PIPELINE_RUNNER)) {
          return {
            content: [
              { type: 'text' as const, text: 'Pipeline runner not built. Run pnpm build first.' },
            ],
            isError: true,
          };
        }
        if (background) {
          const job = startPipelineJob(input, absInput, extraArgs);
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
        const output = safeExec('node', [PIPELINE_RUNNER, '--input', absInput, ...extraArgs], {
          cwd: REPO_ROOT,
          timeoutMs: PIPELINE_TIMEOUT_MS,
          maxOutputMB: 5,
        });
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Pipeline execution failed: ${err}` }],
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
          content: [{ type: 'text' as const, text: `Knowledge search failed: ${err}` }],
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
          content: [{ type: 'text' as const, text: `Failed to list capabilities: ${err}` }],
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
        if (process.env.KYBERION_ENABLE_SERVICE_ACTUATE_TOOL !== '1') {
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
          content: [{ type: 'text' as const, text: `Service actuate failed: ${err}` }],
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
          content: [{ type: 'text' as const, text: `Mission creation failed: ${err}` }],
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
          content: [{ type: 'text' as const, text: `Mission status query failed: ${err}` }],
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
          content: [{ type: 'text' as const, text: `Mission journal read failed: ${err}` }],
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
    },
    async ({ title, summary, content, content_type, mission_id, trace_id, next_action }) => {
      try {
        const deliveryId = deliverToCowork(
          [{ content, content_type: content_type ?? 'text/plain', description: title }],
          { title, summary, missionId: mission_id, traceId: trace_id, nextAction: next_action }
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
          content: [{ type: 'text' as const, text: `Cowork delivery failed: ${err}` }],
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
          content: [{ type: 'text' as const, text: `Failed to list Cowork outbox: ${err}` }],
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
        const result = runCoworkKnowledgeSync({
          direction: direction ?? 'both',
          coworkArtifactPaths: cowork_artifact_paths ?? [],
          maxHints: max_hints ?? 50,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Knowledge sync failed: ${err}` }],
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
          content: [{ type: 'text' as const, text: `Failed to list pending approvals: ${err}` }],
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
          content: [{ type: 'text' as const, text: `Approval decision failed: ${err}` }],
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
        if (!safeExistsSync(AUDIT_EXPORT_SCRIPT)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Audit export script not built. Run pnpm build first.',
              },
            ],
            isError: true,
          };
        }
        const args = [AUDIT_EXPORT_SCRIPT];
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
          content: [{ type: 'text' as const, text: `Audit export failed: ${err}` }],
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
        if (!safeExistsSync(AUDIT_EXPORT_SCRIPT)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Audit export script not built. Run pnpm build first.',
              },
            ],
            isError: true,
          };
        }
        const args = [AUDIT_EXPORT_SCRIPT, '--verify-only'];
        if (effectiveTenant) args.push('--tenant', effectiveTenant);
        const output = safeExec('node', args, {
          cwd: REPO_ROOT,
          timeoutMs: 30_000,
          maxOutputMB: 5,
        });
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Audit verification failed: ${err}` }],
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
  const tenant = String(process.env.KYBERION_TENANT || process.env.KYBERION_TENANT_ID || '').trim();
  const scope = normalizeEventScope(
    tenant
      ? { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant }
      : { scope_kind: 'system', tier: 'public' }
  );
  const principalId =
    String(process.env.KYBERION_MCP_NHI || process.env.KYBERION_MCP_PRINCIPAL || '').trim() ||
    'mcp-server-cowork';
  recordProtocolServiceLifecycle({
    serviceId: 'mcp-server-cowork',
    action: 'start',
    status: 'started',
    scope,
    actorRole: 'surface_runtime',
    principal: { kind: 'service', id: principalId },
    requestedBy: principalId,
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    recordProtocolServiceLifecycle({
      serviceId: 'mcp-server-cowork',
      action: 'stop',
      status: 'stopped',
      scope,
      actorRole: 'surface_runtime',
      principal: { kind: 'service', id: principalId },
      requestedBy: principalId,
    });
    await transport.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
