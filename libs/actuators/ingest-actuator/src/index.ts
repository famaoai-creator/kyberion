/**
 * ingest-actuator/src/index.ts
 * DA-04/DA-05: ingest pipeline for tenant data activation —
 * unstructured internal documents → governed knowledge cards.
 *
 * Ops:
 *   sync_source      (capture)   — DA-03 incremental change-listing (watermark → preset → work list)
 *   parse_document   (capture)   — docx/pdf/xlsx/html/slack_thread/markdown/text → unified IR
 *   normalize_card   (transform) — IR → { target_path, frontmatter, body_markdown, card_markdown }
 *   dedup            (transform) — content-hash registry check + registration
 *   staleness_report (transform) — ledger vs current-source comparison (side-effect free)
 *   commit           (apply)     — DA-05 explicit ingest ceremony: card landing + asset ledger
 *
 * ingest:commit is the ONLY op here that writes into knowledge/ (under the
 * narrowly-scoped ingest_commit authority role, fail-closed path guard).
 * Everything else returns data; the only other write this actuator performs
 * is the dedup registry append under active/shared/runtime/ingest/.
 */

import {
  logger,
  resolveVars,
  stalenessReport,
  ensureDefaultOpPreflight,
  runOpPreflight,
  type IngestSourceObservation,
} from '@agent/core';
import { commitIngest, type IngestCommitInput } from './commit.js';
import { dedupContent, type DedupInput } from './dedup.js';
import { normalizeCard, type NormalizeCardInput } from './normalize-card.js';
import { parseDocument, type ParseDocumentInput } from './parse-document.js';
import { syncSource, type SyncSourceInput } from './sync-source.js';

export {
  DEFAULT_INGEST_REGISTRY_PATH,
  dedupContent,
  type DedupInput,
  type DedupResult,
  type IngestRegistryRecord,
} from './dedup.js';
export {
  IngestCardIncompleteError,
  normalizeCard,
  type CardOverrides,
  type NormalizeCardInput,
  type NormalizeCardResult,
} from './normalize-card.js';
export {
  parseDocument,
  type IngestFormat,
  type IngestIr,
  type IngestSection,
  type IngestSourceMeta,
  type IngestTable,
  type ParseDocumentInput,
} from './parse-document.js';
export {
  INGEST_COMMIT_ROLE,
  PUBLIC_INGEST_ROOT,
  assertTargetInsideTenantRoot,
  commitIngest,
  type IngestCommitInput,
  type IngestCommitResult,
  type IngestScrubOverride,
} from './commit.js';
export {
  extractConfluenceCursor,
  syncSource,
  type SyncSourceInput,
  type SyncSourceItem,
  type SyncSourceResult,
  type SyncSourceSystem,
  type SyncSourceTransport,
} from './sync-source.js';

type IngestOp =
  'sync_source' | 'parse_document' | 'normalize_card' | 'dedup' | 'staleness_report' | 'commit';

interface IngestParams extends Record<string, unknown> {
  export_as?: string;
}

/**
 * Resolve {{vars}} from pipeline context. A string that is exactly one
 * `{{key}}` reference resolves to the context value itself (object-safe —
 * `"ir": "{{ir}}"` wires the parse output into normalize without
 * stringification); anything else gets plain string interpolation.
 */
function resolveDeep(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
    if (exact) {
      const direct = ctx[exact[1]];
      if (direct !== undefined) return direct;
    }
    return resolveVars(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDeep(item, ctx));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        resolveDeep(item, ctx),
      ])
    );
  }
  return value;
}

async function executeOp(
  op: IngestOp | string,
  params: IngestParams,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  switch (op) {
    case 'sync_source': {
      logger.info(
        `[INGEST] Sync source ${String(params.source_system)} for tenant ${String(params.tenant_slug)} (DA-03)`
      );
      const result = await syncSource(params as unknown as SyncSourceInput);
      // Capture ops must land on 'last_capture' when no export_as is given —
      // run_pipeline's capture safety gate reads that channel.
      const exportAs = typeof params.export_as === 'string' ? params.export_as : 'last_capture';
      return { ...ctx, [exportAs]: result };
    }
    case 'parse_document': {
      logger.info(`[INGEST] Parsing document (format: ${String(params.format)})`);
      const ir = await parseDocument(params as unknown as ParseDocumentInput);
      // Capture ops must land on 'last_capture' when no export_as is given —
      // run_pipeline's capture safety gate reads that channel.
      const exportAs = typeof params.export_as === 'string' ? params.export_as : 'last_capture';
      return { ...ctx, [exportAs]: ir };
    }
    case 'normalize_card': {
      logger.info('[INGEST] Normalizing IR into knowledge card candidate');
      const card = normalizeCard(params as unknown as NormalizeCardInput);
      const exportAs = typeof params.export_as === 'string' ? params.export_as : 'card';
      return { ...ctx, [exportAs]: card };
    }
    case 'dedup': {
      logger.info('[INGEST] Checking content-hash registry');
      const result = dedupContent(params as unknown as DedupInput);
      const exportAs = typeof params.export_as === 'string' ? params.export_as : 'dedup';
      return { ...ctx, [exportAs]: result };
    }
    case 'staleness_report': {
      logger.info('[INGEST] Comparing asset ledger against current sources');
      const input = params as unknown as {
        tenant_slug: string;
        current_sources?: IngestSourceObservation[];
        path_options?: { rootDir?: string; env?: NodeJS.ProcessEnv };
      };
      const report = stalenessReport(
        input.tenant_slug,
        input.current_sources ?? [],
        input.path_options ?? {}
      );
      const exportAs = typeof params.export_as === 'string' ? params.export_as : 'staleness';
      return { ...ctx, [exportAs]: report };
    }
    case 'commit': {
      logger.info('[INGEST] Executing explicit ingest ceremony (DA-05)');
      const result = commitIngest(params as unknown as IngestCommitInput);
      const exportAs = typeof params.export_as === 'string' ? params.export_as : 'commit';
      return { ...ctx, [exportAs]: result };
    }
    default:
      throw new Error(`ingest-actuator: unknown op: ${String(op)}`);
  }
}

async function executePipeline(
  steps: Array<{ type?: string; op: string; params?: IngestParams }>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let currentCtx = ctx;
  for (const step of steps) {
    const resolvedParams = resolveDeep(step.params ?? {}, currentCtx) as IngestParams;
    ensureDefaultOpPreflight();
    const preflight = await runOpPreflight({
      op: `ingest:${step.op}`,
      params: resolvedParams,
      context: currentCtx,
      source: 'actuator',
    });
    if (preflight.decision !== 'allow') {
      throw new Error(
        `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation ingest:${step.op} was not admitted.`}`
      );
    }
    const params = preflight.input as IngestParams;
    currentCtx = await executeOp(step.op, params, currentCtx);
  }
  return currentCtx;
}

export async function handleAction(input: {
  action: string;
  steps?: Array<{ type?: string; op: string; params?: IngestParams }>;
  context?: Record<string, unknown>;
  params?: IngestParams & { context?: Record<string, unknown> };
}): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> =
    input.context ?? (input.params?.context as Record<string, unknown>) ?? {};

  if (input.action === 'pipeline' && Array.isArray(input.steps)) {
    return executePipeline(input.steps, ctx);
  }

  // Direct op call
  const { context: _context, ...params } = input.params ?? {};
  const newCtx = await executePipeline([{ op: input.action, params }], ctx);
  return { ...newCtx, status: 'succeeded' };
}

export const INGEST_ACTUATOR_OPS = [
  'sync_source',
  'parse_document',
  'normalize_card',
  'dedup',
  'staleness_report',
  'commit',
] as const;
