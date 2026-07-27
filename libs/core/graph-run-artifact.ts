import { safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type {
  ExecutionGraph,
  GraphEdge,
  GraphNode,
  GraphNodeStatus,
  GraphExecutionOutcome,
} from './graph-scheduler.js';
import { hashPipelineOutput } from './pipeline-run-journal.js';

export interface GraphRunArtifactNode {
  id: string;
  status: GraphNodeStatus;
  duration_ms: number;
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

export function createGraphRunArtifact<T>(
  graph: ExecutionGraph<T>,
  runId?: string,
  traceId?: string
): GraphRunArtifact {
  return {
    version: 1,
    ...(runId ? { run_id: runId } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
    generated_at: new Date().toISOString(),
    nodes: graph.nodes.map((node) => ({ id: node.id, status: 'pending', duration_ms: 0 })),
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
  return pathResolver.shared(`runtime/run-graphs/${safe}.json`);
}

export function persistGraphRunArtifact(artifact: GraphRunArtifact, filePath?: string): string {
  const target = filePath || graphRunArtifactPath(artifact.run_id);
  const dir = target.replace(/[/\\][^/\\]+$/, '');
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  artifact.artifact_path = target;
  safeWriteFile(target, `${JSON.stringify(artifact, null, 2)}\n`);
  return target;
}
