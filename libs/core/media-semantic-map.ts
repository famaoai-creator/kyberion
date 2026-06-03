import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

export interface MediaSemanticRuleEntry {
  layout?: string;
  media?: string;
  semantic_type: string;
}

export interface ProposalEvidenceRuleEntry {
  section_id: string;
  evidence_index: number;
}

export interface ProposalSectionKeywordRuleEntry {
  section_id: string;
  keywords: string[];
}

interface MediaSemanticMapCatalog {
  version: string;
  rules: MediaSemanticRuleEntry[];
  proposal_evidence_rules: ProposalEvidenceRuleEntry[];
  proposal_section_keywords: ProposalSectionKeywordRuleEntry[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-semantic-map.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-semantic-map.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: MediaSemanticMapCatalog | null = null;
let cachedCatalogPath: string | null = null;

const FALLBACK_RULES: MediaSemanticRuleEntry[] = [
  { layout: 'cover-statement', semantic_type: 'hero' },
  { layout: 'doc-title', semantic_type: 'hero' },
  { media: 'hero', semantic_type: 'hero' },
  { media: 'title-page', semantic_type: 'hero' },
  { layout: 'contents', semantic_type: 'summary' },
  { layout: 'doc-contents', semantic_type: 'summary' },
  { media: 'contents', semantic_type: 'summary' },
  { layout: 'title-body', semantic_type: 'summary' },
  { layout: 'doc-summary', semantic_type: 'summary' },
  { layout: 'sheet-overview', semantic_type: 'summary' },
  { media: 'summary', semantic_type: 'summary' },
  { media: 'dashboard', semantic_type: 'summary' },
  { layout: 'evidence-callout', semantic_type: 'evidence' },
  { media: 'evidence', semantic_type: 'evidence' },
  { layout: 'risk-controls', semantic_type: 'control' },
  { media: 'controls', semantic_type: 'control' },
  { layout: 'timeline-roadmap', semantic_type: 'roadmap' },
  { media: 'timeline', semantic_type: 'roadmap' },
  { layout: 'decision-cta', semantic_type: 'decision' },
  { media: 'cta', semantic_type: 'decision' },
  { layout: 'doc-appendix', semantic_type: 'appendix' },
  { media: 'appendix', semantic_type: 'appendix' },
  { layout: 'sheet-signals', semantic_type: 'signals' },
  { media: 'signals', semantic_type: 'signals' },
  { layout: 'sheet-main-table', semantic_type: 'execution' },
  { media: 'table', semantic_type: 'execution' },
  { layout: 'three-point-architecture', semantic_type: 'architecture' },
  { layout: 'diagram-context', semantic_type: 'architecture' },
  { layout: 'operating-model', semantic_type: 'architecture' },
  { media: 'architecture', semantic_type: 'architecture' },
  { media: 'diagram', semantic_type: 'architecture' },
  { media: 'model', semantic_type: 'architecture' },
];

const FALLBACK_PROPOSAL_EVIDENCE_RULES: ProposalEvidenceRuleEntry[] = [
  { section_id: 'why-change', evidence_index: 0 },
  { section_id: 'target-outcome', evidence_index: 1 },
  { section_id: 'solution-shape', evidence_index: 2 },
  { section_id: 'governance', evidence_index: 2 },
  { section_id: 'delivery-plan', evidence_index: 3 },
];

const FALLBACK_PROPOSAL_SECTION_KEYWORDS: ProposalSectionKeywordRuleEntry[] = [
  { section_id: 'why-change', keywords: ['why', 'change', 'pain', 'problem', 'now'] },
  { section_id: 'target-outcome', keywords: ['target', 'journey', 'future', 'outcome', 'vision'] },
  { section_id: 'solution-shape', keywords: ['solution', 'approach', 'shape', 'architecture'] },
  { section_id: 'governance', keywords: ['governance', 'control', 'risk', 'operation'] },
  { section_id: 'delivery-plan', keywords: ['delivery', 'plan', 'roadmap', 'phase'] },
];

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateCatalog(value: unknown, label: string): MediaSemanticMapCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid media semantic map catalog at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MediaSemanticMapCatalog;
}

export function loadMediaSemanticMapCatalog(): MediaSemanticMapCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = {
      version: '1.0.0',
      rules: FALLBACK_RULES,
      proposal_evidence_rules: FALLBACK_PROPOSAL_EVIDENCE_RULES,
      proposal_section_keywords: FALLBACK_PROPOSAL_SECTION_KEYWORDS,
    };
    cachedCatalogPath = CATALOG_PATH;
    return cachedCatalog;
  }
  const parsed = validateCatalog(
    JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string),
    CATALOG_PATH
  );
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  return parsed;
}

export function resolveMediaSemanticType(layoutKey?: string, mediaKind?: string): string {
  const layout = String(layoutKey || '').trim();
  const media = String(mediaKind || '').trim();
  const catalog = loadMediaSemanticMapCatalog();
  const matched = catalog.rules.find((entry) => {
    const layoutMatch = !entry.layout || entry.layout === layout;
    const mediaMatch = !entry.media || entry.media === media;
    return layoutMatch && mediaMatch;
  });
  return matched?.semantic_type || 'content';
}

export function resolveProposalEvidenceIndex(sectionId: string): number | null {
  const normalized = String(sectionId || '').trim();
  if (!normalized) return null;
  const catalog = loadMediaSemanticMapCatalog();
  const matched = catalog.proposal_evidence_rules.find((entry) => entry.section_id === normalized);
  return matched?.evidence_index ?? null;
}

export function resolveProposalSectionKeywords(sectionId: string): string[] {
  const normalized = String(sectionId || '').trim();
  if (!normalized) return [];
  const catalog = loadMediaSemanticMapCatalog();
  const matched = catalog.proposal_section_keywords.find((entry) => entry.section_id === normalized);
  return matched?.keywords || [];
}

export function resetMediaSemanticMapCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
