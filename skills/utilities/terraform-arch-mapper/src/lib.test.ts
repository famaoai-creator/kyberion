import { describe, it, expect } from 'vitest';
import { parseHCL, generateSummary } from './lib';

describe('terraform-arch-mapper lib', () => {
  it('should parse HCL resource definitions', () => {
    const hcl = `
resource "aws_instance" "web" { ami = "x" }
resource "aws_db_instance" "db" { engine = "y" }
resource "google_compute_instance" "app" { name = "z" }
    `;
    const graph = parseHCL(hcl);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes[0]).toEqual({ id: 'web', type: 'aws_instance' });
  });

  it('should generate summary of resources', () => {
    const graph = {
      nodes: [
        { id: 'a', type: 'aws_instance' },
        { id: 'b', type: 'aws_instance' },
        { id: 'c', type: 'aws_s3_bucket' }
      ],
      edges: []
    };
    const summary = generateSummary(graph);
    expect(summary).toContain('3 nodes');
    expect(summary).toContain('0 edges');
  });
});
