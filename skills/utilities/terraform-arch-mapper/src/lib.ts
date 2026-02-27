export interface TFNode {
  id: string;
  type: string;
  name: string;
}

export interface TFEdge {
  from: string;
  to: string;
}

export function parseTerraformContent(content: string): { nodes: TFNode[]; edges: TFEdge[] } {
  const nodes: TFNode[] = [];
  const edges: TFEdge[] = [];

  const resourceMatches = content.matchAll(/resource\s+"([^"]+)"\s+"([^"]+)"\s+\{([\s\S]*?)\}/g);
  for (const match of resourceMatches) {
    const type = match[1];
    const name = match[2];
    const body = match[3];
    const id = type + '.' + name;

    nodes.push({ id, type, name });

    const depMatches = body.matchAll(/[\s=]+(aws_[a-z0-9_]+\.[a-z0-9_]+)/g);
    for (const dep of depMatches) {
      edges.push({ from: id, to: dep[1] });
    }
  }
  return { nodes, edges };
}
