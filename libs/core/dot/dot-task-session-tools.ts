/**
 * Governed work tools for resident-dot `task_session` execution.
 *
 * When a Dot charter explicitly allows `task_session`, these tools give the
 * bounded goal loop real, scope-isolated capabilities (reading allowed files,
 * searching promoted knowledge, writing scoped deliverables, and citing used
 * knowledge) while re-verifying the live WorkItem claim/lease before every call.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { auditChain } from '../governance/audit-chain.js';
import {
  recordKnowledgeDelivery,
  recordKnowledgeUsageFeedback,
  type DeliveredKnowledgeRef,
} from '../knowledge/knowledge-feedback-loop.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';
import {
  findRelevantPromotedKnowledge,
  type PromotedKnowledgeEntry,
} from '../knowledge/promoted-knowledge-retrieval.js';
import { pathResolver } from '../path-resolver.js';
import type { ToolCall, ToolDefinition } from '../reasoning/reasoning-backend-contracts.js';
import type { ScopeContext } from '../scope-context.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeRealpath,
} from '../secure-io.js';
import { writeScopedArtifact, type ScopedArtifactScope } from '../workforce/artifact-store.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { GoalToolExecution } from '../workforce/worker-goal-driver.js';
import type { DotCharter } from './dot-charter.js';
import { dotStatePath } from './dot-state-paths.js';

export const DOT_TASK_SESSION_TOOL_NAMES = [
  'dot_read_scoped_file',
  'dot_search_knowledge',
  'dot_write_scoped_deliverable',
  'dot_cite_knowledge_used',
] as const;

export type DotTaskSessionToolName = (typeof DOT_TASK_SESSION_TOOL_NAMES)[number];

export const DEFAULT_DOT_TASK_MAX_TOOL_CALLS = 24;
export const DEFAULT_DOT_TASK_MAX_READ_BYTES = 128 * 1024;
export const DEFAULT_DOT_TASK_MAX_DELIVERABLE_BYTES = 256 * 1024;

export interface DotTaskDeliverableRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface DotTaskSessionToolSummary {
  toolCalls: number;
  readPaths: string[];
  deliveredKnowledgePaths: string[];
  citedKnowledgePaths: string[];
  deliverables: DotTaskDeliverableRecord[];
}

export interface DotTaskSessionToolContext {
  charter: DotCharter;
  item: WorkItem;
  rootDir?: string;
  /** Must throw if the WorkItem lease/attempt is no longer current or operations are halted. */
  assertCurrent: () => void;
  maxToolCalls?: number;
  maxReadBytes?: number;
  maxDeliverableBytes?: number;
  /** Test/composition seams. */
  findKnowledge?: typeof findRelevantPromotedKnowledge;
  recordDelivery?: typeof recordKnowledgeDelivery;
  recordUsage?: typeof recordKnowledgeUsageFeedback;
  writeArtifact?: typeof writeScopedArtifact;
  audit?: (entry: Parameters<typeof auditChain.record>[0]) => void;
}

export interface DotTaskSessionToolRuntime {
  readonly definitions: ToolDefinition[];
  executeTool(call: ToolCall): Promise<GoalToolExecution>;
  getSummary(): DotTaskSessionToolSummary;
}

const SENSITIVE_FILENAME_PATTERN =
  /(?:^|\/)(?:\.env(?:\.|$)|[^/]*secret[^/]*|[^/]*credential[^/]*)/iu;

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildMemoryScope(charter: DotCharter): MemoryScopeEnvelope {
  return {
    tier: charter.scope.tier,
    ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
    ...(charter.scope.organization_id ? { organization_id: charter.scope.organization_id } : {}),
    ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
    ...(charter.scope.owner_nhi ? { owner_nhi: charter.scope.owner_nhi } : {}),
  };
}

function buildReaderScope(charter: DotCharter): ScopeContext {
  return {
    tier: charter.scope.tier,
    ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
    ...(charter.scope.organization_id ? { organization_id: charter.scope.organization_id } : {}),
    ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
  };
}

function allowedReadPrefixes(charter: DotCharter): string[] {
  const prefixes = ['knowledge/public/', 'knowledge/product/'];
  if (charter.scope.tier === 'confidential' && charter.scope.tenant_slug) {
    prefixes.push(`knowledge/confidential/${charter.scope.tenant_slug}/`);
  }
  const ownState = dotStatePath(charter).replaceAll('\\', '/').replace(/\/+$/u, '');
  if (ownState) {
    prefixes.push(`${ownState}/`);
  }
  return prefixes;
}

function normalizeRepoRelative(rawPath: string): string {
  const trimmed = rawPath.trim().replaceAll('\\', '/');
  if (!trimmed || path.posix.isAbsolute(trimmed) || /^[A-Za-z]:/u.test(trimmed)) {
    throw new Error('[DOT_TASK_TOOL_SCOPE_DENIED] path must be repository-relative');
  }
  const normalized = path.posix.normalize(trimmed).replace(/^\.\//u, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('..') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('[DOT_TASK_TOOL_SCOPE_DENIED] path traversal is not allowed');
  }
  if (SENSITIVE_FILENAME_PATTERN.test(normalized)) {
    throw new Error('[DOT_TASK_TOOL_SCOPE_DENIED] reading secret or env files is forbidden');
  }
  return normalized;
}

function buildArtifactScope(charter: DotCharter): ScopedArtifactScope {
  return {
    tenant: charter.scope.tenant_slug ?? 'shared',
    ...(charter.scope.organization_id ? { organization: charter.scope.organization_id } : {}),
    ...(charter.scope.project_id ? { project: charter.scope.project_id } : {}),
  };
}

function sanitizeDeliverableName(rawName: string, charter: DotCharter, item: WorkItem): string {
  const normalized = rawName.trim().replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    throw new Error('[DOT_TASK_TOOL_INPUT_INVALID] invalid deliverable name');
  }
  const leaf = normalized.split('/').filter(Boolean).join('/');
  if (!leaf || leaf.length > 120 || !/\.(?:md|json|txt)$/iu.test(leaf)) {
    throw new Error(
      '[DOT_TASK_TOOL_INPUT_INVALID] deliverable name must end with .md, .json, or .txt'
    );
  }
  const ownerPrefix =
    charter.scope.tier === 'personal' && charter.scope.owner_nhi
      ? `owners/${sha256Hex(charter.scope.owner_nhi).slice(0, 12)}/`
      : '';
  return `${ownerPrefix}dot-${charter.dot_id}/${item.item_id}/${leaf}`;
}

export function buildDotTaskSessionToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'dot_read_scoped_file',
      description:
        'Read a UTF-8 file strictly inside this charter scope (knowledge/public, knowledge/product, own tenant confidential knowledge, or own dot state).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative path to read.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'dot_search_knowledge',
      description:
        'Search promoted organizational/product knowledge relevant to a topic within this charter scope.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Search query or topic description.' },
          limit: { type: 'integer', minimum: 1, maximum: 8, description: 'Max hits (default 5).' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'dot_write_scoped_deliverable',
      description:
        'Write a bounded report or artifact (.md, .json, or .txt) into this charter scoped artifact store.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'File name ending in .md, .json, or .txt (e.g. summary.md).',
          },
          content: { type: 'string', description: 'UTF-8 deliverable content.' },
          format: { type: 'string', enum: ['markdown', 'json', 'text'] },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'dot_cite_knowledge_used',
      description:
        'Report whether a knowledge document returned by dot_search_knowledge was useful for this task, closing the memory feedback loop.',
      inputSchema: {
        type: 'object',
        properties: {
          document_path: { type: 'string', description: 'Path returned by dot_search_knowledge.' },
          useful: {
            type: 'boolean',
            description: 'True if the document helped complete the task.',
          },
          missing_topics: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional topics that were needed but missing.',
          },
        },
        required: ['document_path', 'useful'],
      },
    },
  ];
}

/**
 * Create a lease-checked, scope-bound tool runtime for a single Dot `task_session` WorkItem claim.
 */
export function createDotTaskSessionToolRuntime(
  ctx: DotTaskSessionToolContext
): DotTaskSessionToolRuntime {
  const maxToolCalls = ctx.maxToolCalls ?? DEFAULT_DOT_TASK_MAX_TOOL_CALLS;
  const maxReadBytes = ctx.maxReadBytes ?? DEFAULT_DOT_TASK_MAX_READ_BYTES;
  const maxDeliverableBytes = ctx.maxDeliverableBytes ?? DEFAULT_DOT_TASK_MAX_DELIVERABLE_BYTES;
  const rootDir = path.resolve(ctx.rootDir ?? pathResolver.rootDir());
  const findKnowledge = ctx.findKnowledge ?? findRelevantPromotedKnowledge;
  const recordDelivery = ctx.recordDelivery ?? recordKnowledgeDelivery;
  const recordUsage = ctx.recordUsage ?? recordKnowledgeUsageFeedback;
  const writeArtifact = ctx.writeArtifact ?? writeScopedArtifact;
  const audit = ctx.audit ?? ((entry) => auditChain.record(entry));

  const readPaths = new Set<string>();
  const deliveredRefs = new Map<string, DeliveredKnowledgeRef>();
  const citedPaths = new Set<string>();
  const deliverables: DotTaskDeliverableRecord[] = [];
  let toolCalls = 0;

  const memoryScope = buildMemoryScope(ctx.charter);
  const readerScope = buildReaderScope(ctx.charter);
  const prefixes = allowedReadPrefixes(ctx.charter);
  const missionId = ctx.item.context?.mission_id ?? `dot:${ctx.charter.dot_id}`;

  const recordToolAudit = (
    toolName: string,
    status: 'allowed' | 'denied' | 'failed',
    detail?: string
  ) => {
    try {
      audit({
        agentId: `dot:${ctx.charter.dot_id}`,
        action: 'dot_task_tool',
        operation: toolName,
        result: status,
        ...(ctx.charter.scope.tenant_slug ? { tenantSlug: ctx.charter.scope.tenant_slug } : {}),
        metadata: {
          work_item_id: ctx.item.item_id,
          tier: ctx.charter.scope.tier,
          ...(ctx.charter.scope.tenant_slug ? { tenant_slug: ctx.charter.scope.tenant_slug } : {}),
          ...(detail ? { detail } : {}),
        },
      });
    } catch {
      // Best effort: audit failure must not fabricate success, and primary error propagates.
    }
  };

  async function executeReadFile(args: Record<string, unknown>): Promise<GoalToolExecution> {
    const rawPath = typeof args.path === 'string' ? args.path : '';
    const relPath = normalizeRepoRelative(rawPath);
    if (!prefixes.some((prefix) => relPath.startsWith(prefix))) {
      throw new Error(
        `[DOT_TASK_TOOL_SCOPE_DENIED] path '${relPath}' is outside charter read scope`
      );
    }
    const candidate = path.resolve(rootDir, relPath);
    if (!ctx.rootDir) {
      assertSafeRepositoryPath(candidate, { allowMissingLeaf: false });
    }
    if (!safeExistsSync(candidate)) {
      throw new Error(`[DOT_TASK_TOOL_NOT_FOUND] file does not exist: ${relPath}`);
    }
    const stat = safeLstat(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('[DOT_TASK_TOOL_SCOPE_DENIED] target must be a regular non-symlink file');
    }
    const realRoot = safeRealpath(rootDir);
    const realTarget = safeRealpath(candidate);
    const realRel = path.relative(realRoot, realTarget).replaceAll('\\', '/');
    if (
      realRel.startsWith('..') ||
      path.isAbsolute(realRel) ||
      !prefixes.some((prefix) => realRel.startsWith(prefix))
    ) {
      throw new Error('[DOT_TASK_TOOL_SCOPE_DENIED] resolved path escapes charter read scope');
    }
    if (stat.size > maxReadBytes) {
      throw new Error(`[DOT_TASK_TOOL_SIZE_EXCEEDED] file exceeds ${maxReadBytes} byte read limit`);
    }
    const content = String(safeReadFile(candidate, { encoding: 'utf8' }));
    readPaths.add(relPath);
    recordToolAudit('dot_read_scoped_file', 'allowed');
    return {
      resultText: JSON.stringify({ path: relPath, bytes: stat.size, content }),
      repeatable: true,
      progress: true,
    };
  }

  async function executeSearchKnowledge(args: Record<string, unknown>): Promise<GoalToolExecution> {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    if (!topic) {
      throw new Error('[DOT_TASK_TOOL_INPUT_INVALID] topic is required');
    }
    const limit =
      typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.min(8, Math.max(1, Math.floor(args.limit)))
        : 5;
    const hits: PromotedKnowledgeEntry[] = await findKnowledge({
      topic,
      limit,
      scope: readerScope,
      ...(ctx.rootDir ? { rootDir } : {}),
    });

    if (hits.length > 0) {
      const refs: DeliveredKnowledgeRef[] = hits.map((hit) => ({
        path: hit.path,
        score: hit.score,
        title: hit.title,
      }));
      const canRecordScope =
        ctx.charter.scope.tier !== 'personal' || Boolean(ctx.charter.scope.owner_nhi);
      const recorded = canRecordScope
        ? recordDelivery({
            missionId,
            taskId: ctx.item.item_id,
            teamRole: ctx.charter.authority.authority_role,
            recipientKind: 'dot_task_session',
            refs,
            scope: memoryScope,
          })
        : undefined;
      for (const ref of recorded?.refs ?? refs) {
        deliveredRefs.set(ref.path, ref);
      }
    }
    recordToolAudit('dot_search_knowledge', 'allowed', `hits=${hits.length}`);
    return {
      resultText: JSON.stringify({ topic, hits }),
      repeatable: true,
      progress: true,
    };
  }

  async function executeWriteDeliverable(
    args: Record<string, unknown>
  ): Promise<GoalToolExecution> {
    const rawName = typeof args.name === 'string' ? args.name : '';
    const content = typeof args.content === 'string' ? args.content : '';
    const format = typeof args.format === 'string' ? args.format : 'markdown';
    if (!content.trim()) {
      throw new Error('[DOT_TASK_TOOL_INPUT_INVALID] content must be non-empty');
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > maxDeliverableBytes) {
      throw new Error(
        `[DOT_TASK_TOOL_SIZE_EXCEEDED] deliverable exceeds ${maxDeliverableBytes} bytes`
      );
    }
    if (format === 'json') {
      JSON.parse(content);
    }
    const scopedName = sanitizeDeliverableName(rawName, ctx.charter, ctx.item);
    const written = writeArtifact({
      scope: buildArtifactScope(ctx.charter),
      tier: ctx.charter.scope.tier,
      artifact_class: 'report',
      name: scopedName,
      content,
      format: 'text',
    });
    const record: DotTaskDeliverableRecord = {
      path: written.repo_relative_path,
      sha256: sha256Hex(content),
      bytes,
    };
    deliverables.push(record);
    recordToolAudit('dot_write_scoped_deliverable', 'allowed');
    return {
      resultText: JSON.stringify(record),
      repeatable: false,
      progress: true,
      externalEffect: true,
      effectDescription: `wrote scoped deliverable ${record.path}`,
    };
  }

  async function executeCiteKnowledge(args: Record<string, unknown>): Promise<GoalToolExecution> {
    const documentPath = typeof args.document_path === 'string' ? args.document_path.trim() : '';
    const useful = typeof args.useful === 'boolean' ? args.useful : undefined;
    if (!documentPath || useful === undefined) {
      throw new Error('[DOT_TASK_TOOL_INPUT_INVALID] document_path and useful are required');
    }
    const deliveredRef = deliveredRefs.get(documentPath);
    if (!deliveredRef) {
      throw new Error(
        `[DOT_TASK_TOOL_SCOPE_DENIED] document '${documentPath}' was not delivered in this task session`
      );
    }
    const missingTopics = Array.isArray(args.missing_topics)
      ? args.missing_topics
          .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
          .slice(0, 5)
      : [];
    const feedbackResult = recordUsage({
      missionId,
      taskId: ctx.item.item_id,
      scope: memoryScope,
      deliveredRefs: [deliveredRef],
      resultId: `dot-task:${ctx.item.item_id}:${documentPath}`,
      outcome: 'worker_report_complete',
      feedback: {
        used: useful ? [documentPath] : [],
        not_used: useful ? [] : [documentPath],
        missing_topics: missingTopics,
      },
    });
    citedPaths.add(documentPath);
    recordToolAudit('dot_cite_knowledge_used', 'allowed', useful ? 'useful' : 'not_useful');
    return {
      resultText: JSON.stringify({
        document_path: documentPath,
        useful,
        usage_updated: feedbackResult.usageUpdated,
      }),
      repeatable: false,
      progress: true,
    };
  }

  return {
    definitions: buildDotTaskSessionToolDefinitions(),
    async executeTool(call: ToolCall): Promise<GoalToolExecution> {
      ctx.assertCurrent();
      toolCalls += 1;
      if (toolCalls > maxToolCalls) {
        recordToolAudit(call.name, 'denied', 'budget_exceeded');
        throw new Error(
          `[DOT_TASK_TOOL_BUDGET_EXCEEDED] exceeded max ${maxToolCalls} tool calls for task_session`
        );
      }
      const args = (call.input ?? {}) as Record<string, unknown>;
      try {
        switch (call.name) {
          case 'dot_read_scoped_file':
            return await executeReadFile(args);
          case 'dot_search_knowledge':
            return await executeSearchKnowledge(args);
          case 'dot_write_scoped_deliverable':
            return await executeWriteDeliverable(args);
          case 'dot_cite_knowledge_used':
            return await executeCiteKnowledge(args);
          default:
            throw new Error(`[DOT_TASK_TOOL_UNKNOWN] unsupported tool '${call.name}'`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('SCOPE_DENIED')) {
          recordToolAudit(call.name, 'denied', 'scope_denied');
        } else {
          recordToolAudit(call.name, 'failed', 'error');
        }
        throw error;
      }
    },
    getSummary(): DotTaskSessionToolSummary {
      return {
        toolCalls,
        readPaths: [...readPaths],
        deliveredKnowledgePaths: [...deliveredRefs.keys()],
        citedKnowledgePaths: [...citedPaths],
        deliverables: [...deliverables],
      };
    },
  };
}
