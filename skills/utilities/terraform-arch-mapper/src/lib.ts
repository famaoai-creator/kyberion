/**
 * Terraform Architecture Mapper Core Library.
 */

export interface ResourceInfo {
  type: string;
  name: string;
  provider: string;
}

export interface TerraformGraph {
  nodes: { id: string; type: string }[];
  edges: { from: string; to: string }[];
}

export function parseHCL(content: string): TerraformGraph {
  const nodes: { id: string; type: string }[] = [];
  const edges: { from: string; to: string }[] = [];
  const lines = content.split('\n');

  lines.forEach((line) => {
    const match = line.match(/resource\s+['"]([^'"]+)['"]\s+['"]([^'"]+)['"]/);
    if (match) {
      nodes.push({ id: match[2], type: match[1] });
    }
  });

  return { nodes, edges };
}

export function parseTerraformContent(content: string) {
  return parseHCL(content);
}

export function generateSummary(graph: TerraformGraph): string {
  return `Architecture Summary: \${graph.nodes.length} nodes, \${graph.edges.length} edges.`;
}
