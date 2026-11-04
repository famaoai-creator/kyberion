/**
 * Surface operation registry — the one API layer behind every surface.
 *
 * Each operation is declared once (id, effect, input schema, handler) and is
 * exposed unchanged by two adapters:
 *   - HTTP: `GET|POST /api/v1/<operation id>` on the unified shell (Concierge)
 *   - MCP:  tool `kyberion.<operation id>` on the Kyberion MCP server
 *
 * Authorization is the caller's server-resolved viewer
 * (`SurfaceAuthorizationContext`); input fields like `tenant` only narrow
 * what that viewer already may see — they never widen it.
 */

import { z } from 'zod';
import { createLogger } from '../logger.js';
import {
  authorizeSurfaceOperation,
  type SurfaceAuthorizationContext,
  type SurfaceOperationPolicy,
} from './surface-authorization.js';
import {
  GRAPH_ENTITY_KINDS,
  collectWorkspaceGraph,
  defaultWorkspaceGraphSources,
  filterWorkspaceGraph,
  getGraphEntity,
  listGraphNodes,
  summarizeWorkspaceGraph,
  type WorkspaceGraph,
  type WorkspaceGraphSources,
} from './workspace-graph.js';
import {
  NEEDS_YOU_REASONS,
  buildNeedsYouQueue,
  pageNeedsYou,
  summarizeNeedsYou,
  type NeedsYouItem,
  type NeedsYouReason,
  type NeedsYouSourceData,
} from './needs-you.js';
import { readNeedsYouSources } from './needs-you-sources.js';

export interface SurfaceOperationContext {
  viewer: SurfaceAuthorizationContext;
  /** Test seam; production reads the governed stores. */
  sources?: WorkspaceGraphSources;
  /**
   * Needs-you reader for this viewer. The unified shell passes its own (it
   * adds owner-authenticated personal approvals); absent → the default store
   * reader. Either way the one builder in `needs-you.ts` counts.
   */
  needsYou?: () => NeedsYouSourceData;
}

export interface SurfaceOperationDescriptor {
  id: string;
  title: string;
  description: string;
  effect: 'read' | 'write';
  /** JSON Schema of the input, for MCP tool listings and the HTTP manifest. */
  inputSchema: Record<string, unknown>;
}

interface SurfaceOperation<I> {
  id: string;
  title: string;
  description: string;
  policy: SurfaceOperationPolicy;
  input: z.ZodType<I>;
  run(ctx: SurfaceOperationContext, input: I): unknown;
}

export type SurfaceOperationResult =
  | { ok: true; operation: string; data: unknown }
  | {
      ok: false;
      operation: string;
      status: 400 | 403 | 404 | 500;
      error_code: string;
      error: string;
    };

const readPolicy = (operationId: string): SurfaceOperationPolicy => ({
  operationId,
  effect: 'read',
  requiredPermissions: ['surface.headless.read'],
});

const ID = z.string().trim().min(1).max(200);
const scopeFilter = {
  tenant: ID.optional(),
  organization_id: ID.optional(),
  project_id: ID.optional(),
};

const GRAPH_TTL_MS = 3000;
let cached: { at: number; graph: WorkspaceGraph } | null = null;

/** Viewer-filtered graph. The unfiltered join is cached briefly per process. */
function viewerGraph(ctx: SurfaceOperationContext): WorkspaceGraph {
  let graph: WorkspaceGraph;
  if (ctx.sources) {
    graph = collectWorkspaceGraph(ctx.sources);
  } else {
    const now = Date.now();
    if (!cached || now - cached.at > GRAPH_TTL_MS) {
      cached = { at: now, graph: collectWorkspaceGraph(defaultWorkspaceGraphSources()) };
    }
    graph = cached.graph;
  }
  return filterWorkspaceGraph(graph, ctx.viewer);
}

/** Drop the cached join (after a write that changes what the graph shows). */
export function invalidateWorkspaceGraphCache(): void {
  cached = null;
}

const operations = [
  {
    id: 'workspace.summary',
    title: 'Workspace summary',
    description:
      'Counts of tenants, organizations, projects, missions, work items, approvals and actors the viewer can see, the tenant → organization → project tree, and items that need attention.',
    policy: readPolicy('workspace.summary'),
    input: z.object({}).strict(),
    run: (ctx: SurfaceOperationContext) => summarizeWorkspaceGraph(viewerGraph(ctx)),
  } satisfies SurfaceOperation<Record<string, never>>,
  {
    id: 'workspace.list',
    title: 'List workspace entities',
    description:
      'List entities of one kind, optionally narrowed by tenant, organization, project, mission, actor, status or a text query.',
    policy: readPolicy('workspace.list'),
    input: z
      .object({
        kind: z.enum(GRAPH_ENTITY_KINDS),
        ...scopeFilter,
        mission_id: ID.optional(),
        actor_id: ID.optional(),
        status: ID.optional(),
        q: z.string().trim().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .strict(),
    run: (
      ctx: SurfaceOperationContext,
      input: {
        kind: (typeof GRAPH_ENTITY_KINDS)[number];
        tenant?: string;
        organization_id?: string;
        project_id?: string;
        mission_id?: string;
        actor_id?: string;
        status?: string;
        q?: string;
        limit?: number;
      }
    ) => ({
      items: listGraphNodes(viewerGraph(ctx), {
        kind: input.kind,
        tenantSlug: input.tenant,
        organizationId: input.organization_id,
        projectId: input.project_id,
        missionId: input.mission_id,
        actorId: input.actor_id,
        status: input.status,
        q: input.q,
        limit: input.limit,
      }),
    }),
  },
  {
    id: 'workspace.get',
    title: 'Get workspace entity',
    description:
      'One entity with its lineage (tenant › organization › project › mission), contained entities grouped by kind, and the actors involved. Missions include their tasks and staffing.',
    policy: readPolicy('workspace.get'),
    input: z.object({ kind: z.enum(GRAPH_ENTITY_KINDS), id: ID }).strict(),
    run: (
      ctx: SurfaceOperationContext,
      input: { kind: (typeof GRAPH_ENTITY_KINDS)[number]; id: string }
    ) => {
      const view = getGraphEntity(
        viewerGraph(ctx),
        input.kind,
        input.id,
        ctx.sources ?? defaultWorkspaceGraphSources()
      );
      if (!view)
        throw new OperationNotFound(`${input.kind} ${input.id} is not visible in this scope.`);
      return view;
    },
  },
  {
    id: 'workspace.search',
    title: 'Search the workspace',
    description: 'Find entities of any kind by id, name, summary or status.',
    policy: readPolicy('workspace.search'),
    input: z
      .object({
        q: z.string().trim().min(1).max(200),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict(),
    run: (ctx: SurfaceOperationContext, input: { q: string; limit?: number }) => ({
      items: listGraphNodes(viewerGraph(ctx), { q: input.q, limit: input.limit ?? 30 }),
    }),
  },
] as const;

class OperationNotFound extends Error {}

const needsYouNarrowing = {
  tenant: ID.optional(),
  organization_id: ID.optional(),
  project_id: ID.optional(),
};

/** The viewer's open queue (needs-you.ts count definition), narrowed by the input. */
function viewerNeedsYou(
  ctx: SurfaceOperationContext,
  input: { tenant?: string; organization_id?: string; project_id?: string }
): NeedsYouItem[] {
  const data = ctx.needsYou ? ctx.needsYou() : readNeedsYouSources(ctx.viewer);
  return buildNeedsYouQueue(data, { viewer: ctx.viewer, narrowing: input });
}

const needsYouOperations = [
  {
    id: 'needs-you.list',
    title: 'List what needs you',
    description:
      'Open items waiting for a person (approvals, customer decisions, deliverable reviews, knowledge candidates, stalled requests, failures) in urgency order. Identical approvals are folded with their true count. Filter by reason or overdue; page with the cursor.',
    policy: readPolicy('needs-you.list'),
    input: z
      .object({
        ...needsYouNarrowing,
        reason: z.enum(NEEDS_YOU_REASONS).optional(),
        overdue: z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).optional(),
        cursor: z
          .string()
          .trim()
          .regex(/^\d{1,6}$/u)
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .strict(),
    run: (
      ctx: SurfaceOperationContext,
      input: {
        tenant?: string;
        organization_id?: string;
        project_id?: string;
        reason?: NeedsYouReason;
        overdue?: boolean | 'true' | 'false' | '1' | '0';
        cursor?: string;
        limit?: number;
      }
    ) =>
      pageNeedsYou(viewerNeedsYou(ctx, input), {
        reason: input.reason,
        overdue: input.overdue === true || input.overdue === 'true' || input.overdue === '1',
        cursor: input.cursor,
        limit: input.limit,
      }),
  },
  {
    id: 'needs-you.summary',
    title: 'Needs-you summary',
    description:
      'The one needs-you count: open items by reason, how many are overdue, and the oldest wait. Every surface that shows a count of things to decide reads this.',
    policy: readPolicy('needs-you.summary'),
    input: z.object(needsYouNarrowing).strict(),
    run: (
      ctx: SurfaceOperationContext,
      input: { tenant?: string; organization_id?: string; project_id?: string }
    ) => summarizeNeedsYou(viewerNeedsYou(ctx, input)),
  },
];

const logger = createLogger('surface-operations');

type AnyOperation = SurfaceOperation<unknown>;
const REGISTRY = new Map<string, AnyOperation>(
  [...operations, ...needsYouOperations].map((op) => [op.id, op as unknown as AnyOperation])
);

export function listSurfaceOperations(): SurfaceOperationDescriptor[] {
  return [...REGISTRY.values()].map((op) => ({
    id: op.id,
    title: op.title,
    description: op.description,
    effect: op.policy.effect,
    inputSchema: z.toJSONSchema(op.input) as Record<string, unknown>,
  }));
}

/**
 * The operation's input as a zod raw shape (object fields), for adapters such
 * as the MCP server whose tool registration takes a shape, not a schema.
 */
export function surfaceOperationInputShape(id: string): z.ZodRawShape {
  const op = REGISTRY.get(id);
  if (!op) throw new Error(`Unknown operation ${id}.`);
  return (op.input as unknown as z.ZodObject<z.ZodRawShape>).shape;
}

export function hasSurfaceOperation(id: string): boolean {
  return REGISTRY.has(id);
}

export function invokeSurfaceOperation(
  id: string,
  rawInput: unknown,
  ctx: SurfaceOperationContext
): SurfaceOperationResult {
  const op = REGISTRY.get(id);
  if (!op)
    return {
      ok: false,
      operation: id,
      status: 404,
      error_code: 'unknown_operation',
      error: `Unknown operation ${id}.`,
    };
  const decision = authorizeSurfaceOperation({ context: ctx.viewer, operation: op.policy });
  if (!decision.allowed) {
    return {
      ok: false,
      operation: id,
      status: 403,
      error_code: decision.reasonCode,
      error: decision.reason,
    };
  }
  const parsed = op.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      operation: id,
      status: 400,
      error_code: 'invalid_input',
      error: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; '),
    };
  }
  try {
    return { ok: true, operation: id, data: op.run(ctx, parsed.data) };
  } catch (error) {
    if (error instanceof OperationNotFound)
      return {
        ok: false,
        operation: id,
        status: 404,
        error_code: 'not_found',
        error: error.message,
      };
    logger.warn(
      `surface operation ${id} failed — ${error instanceof Error ? error.message : String(error)} | next: check the store it reads | evidence: operation=${id}`
    );
    return {
      ok: false,
      operation: id,
      status: 500,
      error_code: 'operation_failed',
      error: 'The operation failed; see the server log.',
    };
  }
}

/** Query-string → input object for GET requests (all values are strings; zod coerces numbers). */
export function surfaceOperationInputFromQuery(params: URLSearchParams): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [key, value] of params) input[key] = value;
  return input;
}
