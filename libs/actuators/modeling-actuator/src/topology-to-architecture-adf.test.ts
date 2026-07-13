import { describe, expect, it } from 'vitest';
import { topologyIrToArchitectureAdf } from './topology-to-architecture-adf.js';
import type { TerraformTopologyIr } from './topology-ir.js';

function emptyIr(title: string): TerraformTopologyIr {
  return {
    kind: 'terraform_topology_ir',
    version: '1.0.0',
    source_kind: 'terraform',
    source_root: '/tmp/example',
    title,
    provider: 'aws',
    tfFiles: [],
    allBlocks: [],
    runtimeBlocks: [],
    moduleSourceDirs: [],
    callerBlocksBySource: {},
  };
}

describe('topologyIrToArchitectureAdf container ids (IP-09: canonical slugify)', () => {
  it('slugifies a title with spaces and punctuation the same way the pre-consolidation local slugify() did', () => {
    const adf = topologyIrToArchitectureAdf(emptyIr('My Example, v2!'));
    const exampleContainer = adf.nodes.find((n: any) => n.type === 'terraform_example');
    expect(exampleContainer.id).toBe('container::my-example-v2');
  });

  it('produces an empty-but-defined slug for a title with no alphanumeric characters', () => {
    const adf = topologyIrToArchitectureAdf(emptyIr('!!!'));
    const exampleContainer = adf.nodes.find((n: any) => n.type === 'terraform_example');
    expect(exampleContainer.id).toBe('container::');
  });
});
