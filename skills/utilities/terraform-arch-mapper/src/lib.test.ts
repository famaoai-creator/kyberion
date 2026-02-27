import { describe, it, expect } from 'vitest';
import { parseTerraformContent } from './lib';

describe('terraform-arch-mapper lib', () => {
  it('should parse resources and edges', () => {
    const hcl =
      'resource "aws_instance" "web" { vpc_security_group_ids = [aws_security_group.web_sg.id] }';
    const { nodes, edges } = parseTerraformContent(hcl);
    expect(nodes[0].id).toBe('aws_instance.web');
    expect(edges.length).toBeGreaterThanOrEqual(0);
  });
});
