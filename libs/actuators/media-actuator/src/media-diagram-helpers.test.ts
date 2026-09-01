import { describe, expect, it } from 'vitest';
import {
  parseDiagramGraph,
  parseDrawioIconMap,
  resolveDrawioIconMap,
  resolveGraphDefinition,
} from './media-diagram-helpers.js';
import { pathResolver } from '@agent/core/path-resolver';

const graph = {
  version: '1.1.0',
  nodes: [{ id: 'vpc', type: 'aws_vpc', name: 'main' }],
  edges: [{ from: 'vpc', to: 'vpc', label: 'self' }],
};

describe('media diagram JSON boundaries', () => {
  it('accepts architecture graph nodes and edges with additional renderer hints', () => {
    expect(parseDiagramGraph({ ...graph, render_hints: { direction: 'LR' } })).toMatchObject(graph);
  });

  it.each([
    { ...graph, nodes: [{ id: 'vpc', type: 'aws_vpc' }] },
    { ...graph, edges: [{ from: 'vpc' }] },
    {
      ...graph,
      nodes: [
        { id: 'vpc', type: 'aws_vpc', name: 'one' },
        { id: 'vpc', type: 'aws_vpc', name: 'two' },
      ],
    },
    { ...graph, edges: [{ from: 'vpc', to: 'missing' }] },
  ])('rejects an invalid graph shape: %p', (value) => {
    expect(parseDiagramGraph(value)).toBeNull();
  });

  it('accepts icon resources and validates optional asset fields', () => {
    expect(
      parseDrawioIconMap({
        version: '1.0.0',
        resources: {
          aws_vpc: {
            label: 'VPC',
            asset_candidates: ['icons/vpc.svg'],
          },
          default: {},
        },
      })
    ).toMatchObject({ resources: { aws_vpc: { label: 'VPC' } } });
  });

  it.each([
    { resources: { aws_vpc: { asset_candidates: [42] } } },
    { resources: { aws_vpc: { fillColor: 42 } } },
    { resources: { aws_vpc: [] } },
    { resources: [] },
  ])('rejects an invalid icon map shape: %p', (value) => {
    expect(parseDrawioIconMap(value)).toBeNull();
  });

  it('fails closed when context or inline graph is malformed', () => {
    expect(() =>
      resolveGraphDefinition('/repo', { from: 'graph' }, { graph: { nodes: [] } }, () => undefined)
    ).toThrow('invalid context graph');
    expect(() =>
      resolveGraphDefinition('/repo', { graph: { nodes: [] } }, {}, (value: unknown) => value)
    ).toThrow('invalid inline graph');
  });

  it('parses the repository architecture example at the input boundary', () => {
    const parsed = resolveGraphDefinition(
      pathResolver.rootDir(),
      { input_path: 'knowledge/product/schemas/architecture-adf.example.json' },
      {},
      (value: unknown) => value
    );
    expect(parsed.nodes).toHaveLength(6);
    expect(parsed.edges).toHaveLength(2);
  });

  it('parses the repository AWS icon map at the input boundary', () => {
    const parsed = resolveDrawioIconMap(pathResolver.rootDir(), {}, () => undefined);
    expect(parsed.resources.aws_vpc).toMatchObject({ label: 'Amazon VPC' });
  });

  it('returns an empty map when the optional icon map file is absent', () => {
    expect(
      resolveDrawioIconMap(
        pathResolver.rootDir(),
        { icon_map_path: 'missing-icon-map.json' },
        () => 'missing-icon-map.json'
      )
    ).toEqual({ resources: {} });
  });
});
