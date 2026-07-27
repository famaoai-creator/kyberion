import { describe, expect, it } from 'vitest';
import { createAgentCollaborationEvent } from './agent-collaboration-events.js';
import { composeAgentCollaborationProjection } from './agent-collaboration-projection.js';
import { deriveExecutionGraph } from './graph-scheduler.js';
import { createGraphRunArtifact, recordGraphRunNode } from './graph-run-artifact.js';

describe('graph run artifact', () => {
  it('captures node outcomes and projects them into collaboration graph surfaces', () => {
    const graph = deriveExecutionGraph([
      { id: 'source', produces: 'records' },
      { id: 'sink', consumes: 'records' },
    ]).graph;
    const artifact = createGraphRunArtifact(graph, 'run-1');
    recordGraphRunNode(
      artifact,
      graph.nodes[0],
      { status: 'success', context: { records: [{ id: 1 }] } },
      12
    );
    expect(artifact.nodes[0]).toMatchObject({ id: 'source', status: 'success', duration_ms: 12 });
    expect(artifact.edges).toEqual([
      { from: 'source', to: 'sink', kind: 'data', channel: 'records' },
    ]);

    const projection = composeAgentCollaborationProjection(
      [
        createAgentCollaborationEvent({
          source_event_id: 'run-1',
          ts: '2026-07-28T00:00:00.000Z',
          seq: 1,
          actor_type: 'system',
          kind: 'progress',
          summary: 'pipeline run',
          source: 'runtime',
        }),
      ],
      { runGraph: artifact }
    );
    expect(projection.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'run-graph:run-1', type: 'artifact' }),
        expect.objectContaining({ id: 'run-graph:run-1:node:source', state: 'success' }),
      ])
    );
  });
});
