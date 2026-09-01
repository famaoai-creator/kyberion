import { resolveLatinFontFamily } from '@agent/core/design-fonts';
import { assertSafeRepositoryPath, loadJson, safeExistsSync } from '@agent/core/secure-io';
import * as path from 'node:path';

export interface DiagramGraphNode extends Record<string, unknown> {
  id: string;
  type: string;
  name: string;
}

export interface DiagramGraphEdge extends Record<string, unknown> {
  from: string;
  to: string;
}

export interface DiagramGraph extends Record<string, unknown> {
  nodes: DiagramGraphNode[];
  edges: DiagramGraphEdge[];
  title?: string;
  render_hints?: Record<string, unknown> & {
    direction?: string;
    theme?: string;
  };
}

export interface DrawioIconMapResource extends Record<string, unknown> {
  label?: string;
  fillColor?: string;
  strokeColor?: string;
  accentColor?: string;
  asset_path?: string;
  asset_candidates?: string[];
  data_uri?: string;
}

export interface DrawioIconMap extends Record<string, unknown> {
  resources: Record<string, DrawioIconMapResource>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseDiagramGraphNode(value: unknown): DiagramGraphNode | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.type) || !nonEmptyString(value.name)) {
    return null;
  }
  return value as DiagramGraphNode;
}

function parseDiagramGraphEdge(value: unknown): DiagramGraphEdge | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.from) || !nonEmptyString(value.to)) return null;
  return value as DiagramGraphEdge;
}

export function parseDiagramGraph(value: unknown): DiagramGraph | null {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
  const nodes = value.nodes.map(parseDiagramGraphNode);
  const edges = value.edges.map(parseDiagramGraphEdge);
  if (nodes.some((node) => node === null) || edges.some((edge) => edge === null)) return null;

  const parsedNodes = nodes as DiagramGraphNode[];
  const nodeIds = new Set<string>();
  for (const node of parsedNodes) {
    if (nodeIds.has(node.id)) return null;
    nodeIds.add(node.id);
  }
  const parsedEdges = edges as DiagramGraphEdge[];
  if (parsedEdges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))) return null;
  return {
    ...value,
    nodes: parsedNodes,
    edges: parsedEdges,
  };
}

function parseDrawioIconMapResource(value: unknown): DrawioIconMapResource | null {
  if (!isRecord(value)) return null;
  for (const key of [
    'label',
    'fillColor',
    'strokeColor',
    'accentColor',
    'asset_path',
    'data_uri',
  ]) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
  }
  if (
    value.asset_candidates !== undefined &&
    (!Array.isArray(value.asset_candidates) ||
      value.asset_candidates.some((candidate) => typeof candidate !== 'string'))
  ) {
    return null;
  }
  return value as DrawioIconMapResource;
}

export function parseDrawioIconMap(value: unknown): DrawioIconMap | null {
  if (!isRecord(value) || !isRecord(value.resources)) return null;
  const resources: Record<string, DrawioIconMapResource> = {};
  for (const [key, resource] of Object.entries(value.resources)) {
    if (!key.trim()) return null;
    const parsed = parseDrawioIconMapResource(resource);
    if (!parsed) return null;
    resources[key] = parsed;
  }
  return { ...value, resources };
}

function resolveDiagramRepositoryPath(rootDir: string, value: unknown, label: string): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`${label}: path is required`);
  return assertSafeRepositoryPath(path.resolve(rootDir, requested), {
    allowMissingLeaf: true,
  });
}

export function buildMermaidConfig(theme: any, backgroundColor?: string): Record<string, any> {
  const colors = theme?.colors || {};
  const fonts = theme?.fonts || {};
  const textColor = colors.text || colors.secondary || '#1e293b';
  const primaryColor = colors.accent || '#38bdf8';
  const lineColor = colors.primary || '#0f172a';

  return {
    theme: 'base',
    look: 'classic',
    background: backgroundColor || colors.background || '#ffffff',
    themeVariables: {
      background: backgroundColor || colors.background || '#ffffff',
      primaryColor,
      primaryTextColor: textColor,
      primaryBorderColor: lineColor,
      lineColor,
      secondaryColor: colors.secondary || '#334155',
      tertiaryColor: colors.background || '#ffffff',
      mainBkg: colors.background || '#ffffff',
      textColor,
      fontFamily: fonts.body || fonts.heading || resolveLatinFontFamily(undefined),
    },
  };
}

export function resolveGraphDefinition(
  rootDir: string,
  params: any,
  ctx: any,
  resolve: Function
): DiagramGraph {
  if (params.from && ctx[params.from] !== undefined) {
    const graph = parseDiagramGraph(ctx[params.from]);
    if (!graph) throw new Error('drawio_from_graph received an invalid context graph');
    return graph;
  }

  const inlineGraph = resolve(params.graph);
  if (inlineGraph !== undefined) {
    const graph = parseDiagramGraph(inlineGraph);
    if (!graph) throw new Error('drawio_from_graph received an invalid inline graph');
    return graph;
  }

  if (params.input_path) {
    const inputPath = resolveDiagramRepositoryPath(
      rootDir,
      resolve(params.input_path),
      'drawio_from_graph'
    );
    const graph = parseDiagramGraph(loadJson<unknown>(inputPath));
    if (!graph) throw new Error(`drawio_from_graph received an invalid graph: ${inputPath}`);
    return graph;
  }

  throw new Error('drawio_from_graph requires params.from, params.graph, or params.input_path');
}

export function resolveDrawioIconMap(
  rootDir: string,
  params: any,
  resolve: Function
): DrawioIconMap {
  const mapPath = params.icon_map_path
    ? resolveDiagramRepositoryPath(rootDir, resolve(params.icon_map_path), 'drawio icon map')
    : resolveDiagramRepositoryPath(
        rootDir,
        'knowledge/public/design-patterns/media-templates/aws-drawio-icon-map.json',
        'drawio icon map'
      );

  if (!safeExistsSync(mapPath)) {
    return { resources: {} };
  }

  const iconMap = parseDrawioIconMap(loadJson<unknown>(mapPath));
  if (!iconMap) throw new Error(`drawio icon map is malformed: ${mapPath}`);
  return iconMap;
}

export function loadFallbackDrawioTheme(
  rootDir: string,
  preferredTheme?: string,
  loadThemeCatalog?: (rootDir: string) => any
): any {
  const themes = loadThemeCatalog ? loadThemeCatalog(rootDir) : null;
  if (!themes || typeof themes !== 'object' || !themes.themes) {
    return {
      colors: {
        primary: '#232f3e',
        secondary: '#4b5563',
        accent: '#ff9900',
        background: '#ffffff',
        text: '#111827',
      },
      fonts: {
        heading: resolveLatinFontFamily(undefined),
        body: resolveLatinFontFamily(undefined),
      },
    };
  }
  return (
    themes.themes?.[preferredTheme || ''] ||
    themes.themes?.['aws-architecture'] ||
    themes.themes?.['kyberion-sovereign'] ||
    themes.themes?.['kyberion-standard']
  );
}
