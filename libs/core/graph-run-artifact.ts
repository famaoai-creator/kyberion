import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type {
  ExecutionGraph,
  GraphEdge,
  GraphNode,
  GraphNodeStatus,
  GraphExecutionOutcome,
} from './graph-scheduler.js';
import { hashPipelineOutput } from './pipeline-run-journal.js';
import { nowIso } from './foundation/time.js';

export interface GraphRunArtifactNode {
  id: string;
  status: GraphNodeStatus;
  duration_ms: number;
  timeout_ms?: number;
  output_hash?: string;
}

export interface GraphRunArtifact {
  version: 1;
  run_id?: string;
  trace_id?: string;
  artifact_path?: string;
  generated_at: string;
  nodes: GraphRunArtifactNode[];
  edges: GraphEdge[];
}

const GRAPH_RUN_ARTIFACT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/graph-run-artifact.schema.json'
);

function graphRunArtifactCatalog(filePath: string) {
  return defineCatalog<GraphRunArtifact>({
    id: 'graph-run-artifact',
    path: filePath,
    schema: GRAPH_RUN_ARTIFACT_SCHEMA_PATH,
  });
}

export function createGraphRunArtifact<T>(
  graph: ExecutionGraph<T>,
  runId?: string,
  traceId?: string
): GraphRunArtifact {
  return {
    version: 1,
    ...(runId ? { run_id: runId } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
    generated_at: nowIso(),
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      status: 'pending' as const,
      duration_ms: 0,
      ...(node.timeoutMs !== undefined ? { timeout_ms: node.timeoutMs } : {}),
    })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

export function recordGraphRunNode<T, C>(
  artifact: GraphRunArtifact,
  node: GraphNode<T>,
  outcome: GraphExecutionOutcome<C>,
  durationMs: number
): void {
  const target = artifact.nodes.find((entry) => entry.id === node.id);
  if (!target) return;
  target.status = outcome.status;
  target.duration_ms = Math.max(0, Math.round(durationMs));
  if (outcome.context !== undefined) target.output_hash = hashPipelineOutput(outcome.context);
}

export function graphRunArtifactPath(runId?: string): string {
  const safe = String(runId || 'run').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return assertSafeRepositoryPath(pathResolver.shared(`runtime/run-graphs/${safe}.json`), {
    allowMissingLeaf: true,
  });
}

export function persistGraphRunArtifact(artifact: GraphRunArtifact, filePath?: string): string {
  const target = assertSafeRepositoryPath(filePath || graphRunArtifactPath(artifact.run_id), {
    allowMissingLeaf: true,
  });
  const dir = path.dirname(target);
  assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  artifact.artifact_path = target;
  const canonical = graphRunArtifactCatalog(target).validate(artifact, target);
  safeWriteFile(target, `${JSON.stringify(canonical, null, 2)}\n`);
  return target;
}
