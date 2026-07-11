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
} from '@agent/core';
import { buildKnowledgeIndex, queryKnowledge, executeServicePreset } from '@agent/core';
import { deliverToCowork, listCoworkOutbox } from '@agent/core/cowork-surface.js';
import {
  listPendingApprovalsForCowork,
  decideApprovalFromCowork,
  recordAuditExportRequest,
} from '@agent/core/approval-cowork-adapter.js';
import { runCoworkKnowledgeSync } from '@agent/core/cowork-knowledge-bridge.js';

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
}

function loadCatalog(): ToolCatalog {
  try {
    const raw = safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string;
    return JSON.parse(raw) as ToolCatalog;
  } catch {
    return { pipeline_run_allowlist: [] };
  }
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

function getMissionStatus(missionId: string): string {
  return safeExec(
    'node',
    [
      nodePath.join(REPO_ROOT, 'dist/scripts/mission_controller.js'),
      'status',
      '--mission-id',
      missionId,
    ],
    {
      cwd: REPO_ROOT,
      timeoutMs: 15_000,
      maxOutputMB: 2,
    }
  );
}

function getMissionJournal(missionId: string): string {
  return safeExec(
    'node',
    [nodePath.join(REPO_ROOT, 'dist/scripts/mission_journal.js'), '--mission-id', missionId],
    {
      cwd: REPO_ROOT,
      timeoutMs: 15_000,
      maxOutputMB: 2,
    }
  );
}

function createMission(brief: string, title: string): string {
  return safeExec(
    'node',
    [
      nodePath.join(REPO_ROOT, 'dist/scripts/mission_controller.js'),
      'create',
      '--brief',
      brief,
      '--title',
      title,
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
  server.tool(
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
  server.tool(
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
  server.tool(
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
  server.tool(
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
  server.tool(
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
  server.tool(
    'kyberion.service.actuate',
    'Execute a Kyberion service actuator (e.g. Notion API) operation.',
    {
      service_id: z.string().describe('The ID of the service (e.g. "notion")'),
      action: z.string().describe('The operation to execute (e.g. "search", "retrieve_page")'),
      params: z
        .record(z.string(), z.any())
        .optional()
        .describe('Parameters for the operation (payload/query string)'),
    },
    async ({ service_id, action, params }) => {
      try {
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
  server.tool(
    'kyberion.mission.create',
    'Create a new Kyberion mission. Returns the mission ID.',
    {
      title: z.string().describe('Short mission title'),
      brief: z.string().describe('Mission brief — describe the goal in plain language'),
    },
    async ({ title, brief }) => {
      try {
        const output = createMission(brief, title);
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
  server.tool(
    'kyberion.mission.status',
    'Get the current status of a Kyberion mission.',
    {
      mission_id: z.string().describe('The mission ID to query'),
    },
    async ({ mission_id }) => {
      try {
        const output = getMissionStatus(mission_id);
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
  server.tool(
    'kyberion.mission.journal',
    'Read the journal log of a Kyberion mission.',
    {
      mission_id: z.string().describe('The mission ID whose journal to read'),
    },
    async ({ mission_id }) => {
      try {
        const output = getMissionJournal(mission_id);
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
  server.tool(
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
  server.tool(
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
  server.tool(
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
  server.tool(
    'kyberion.approval.list_pending',
    'List all pending Kyberion approval requests. Call this before kyberion.approval.decide.',
    {},
    async () => {
      try {
        const pending = listPendingApprovalsForCowork();
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
  server.tool(
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
        const result = decideApprovalFromCowork({
          requestId: request_id,
          decision,
          decidedBy: decided_by,
          note,
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
  server.tool(
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
        if (tenant) args.push('--tenant', tenant);
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
  server.tool(
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
        if (tenant) args.push('--tenant', tenant);
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
}
