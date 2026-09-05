import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

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

const CATALOG_PATH = pathResolver.knowledge('product/governance/media-semantic-map.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/media-semantic-map.schema.json');

const mediaSemanticMapCatalog = defineCatalog<MediaSemanticMapCatalog>({
  id: 'media-semantic-map',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadMediaSemanticMapCatalog(): MediaSemanticMapCatalog {
  return mediaSemanticMapCatalog.load();
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
  const matched = catalog.proposal_section_keywords.find(
    (entry) => entry.section_id === normalized
  );
  return matched?.keywords || [];
}
