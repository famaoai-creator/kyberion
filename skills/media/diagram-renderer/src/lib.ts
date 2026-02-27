import { DocumentArtifact } from '@agent/core/shared-business-types';

export interface ADFNode {
  id: string;
  type: string;
  name: string;
}

export interface ADFEdge {
  from: string;
  to: string;
  label?: string;
}

export interface ADF {
  nodes: ADFNode[];
  edges: ADFEdge[];
}

export interface IconMap {
  default: string;
  [key: string]: string;
}

/**
 * Converts Architecture Description Format (ADF) to Mermaid string.
 */
export function adfToMermaid(adf: ADF, iconMap: IconMap): string {
  // Validate ADF structure
  if (!adf || !Array.isArray(adf.nodes)) {
    throw new Error('Invalid ADF: "nodes" array is required.');
  }
  if (!Array.isArray(adf.edges)) {
    throw new Error('Invalid ADF: "edges" array is required.');
  }

  let mmd = `graph LR\n`;

  adf.nodes.forEach((node) => {
    if (!node.id || !node.name) return; // Skip incomplete nodes
    const id = node.id.replace(/[\.\-]/g, '_');
    const icon = iconMap[node.type] || iconMap.default;
    const label = `"${icon} ${node.name}"`;
    mmd += `    ${id}(${label})\n`;
  });

  adf.edges.forEach((edge) => {
    if (!edge.from || !edge.to) return; // Skip incomplete edges
    const from = edge.from.replace(/[\.\-]/g, '_');
    const to = edge.to.replace(/[\.\-]/g, '_');
    const label = edge.label ? `|"${edge.label}"|` : '';
    mmd += `    ${from} -->${label} ${to}\n`;
  });

  return mmd;
}

/**
 * Renders ADF to a DocumentArtifact containing Mermaid source.
 */
export function renderDiagramArtifact(title: string, adf: ADF, iconMap: IconMap): DocumentArtifact {
  const mmd = adfToMermaid(adf, iconMap);
  return {
    title,
    body: mmd,
    format: 'text', // Mermaid is plain text source
    metadata: { adf },
  };
}
