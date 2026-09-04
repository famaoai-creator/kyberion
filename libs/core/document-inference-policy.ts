import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface DocumentInferenceTypeRuleEntry {
  document_type: string;
  keywords: string[];
}

export interface DocumentInferenceProfileRuleEntry {
  document_type: string;
  profile_ids: string[];
  keywords: string[];
}

interface DocumentInferencePolicyCatalog {
  version: string;
  type_rules: DocumentInferenceTypeRuleEntry[];
  profile_rules: DocumentInferenceProfileRuleEntry[];
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/document-inference-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/document-inference-policy.schema.json');

const catalog = defineCatalog<DocumentInferencePolicyCatalog>({
  id: 'document-inference-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
});

export function loadDocumentInferencePolicyCatalog(): DocumentInferencePolicyCatalog {
  return catalog.load();
}

export function resolveDocumentTypeFromClues(clueText: string): string {
  const normalized = String(clueText || '').toLowerCase();
  if (!normalized) return '';
  const catalog = loadDocumentInferencePolicyCatalog();
  for (const rule of catalog.type_rules) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) return rule.document_type;
  }
  return '';
}

export function resolveDocumentProfileCandidates(
  documentType: string,
  artifactFamily: string
): string[] {
  const docType = String(documentType || '').trim();
  const family = String(artifactFamily || '').trim();
  const catalog = loadDocumentInferencePolicyCatalog();
  const matched = catalog.profile_rules.find(
    (rule) => rule.document_type === docType || rule.document_type === family
  );
  return matched?.profile_ids || [];
}

export function resolveDocumentProfileKeywords(
  documentType: string,
  artifactFamily: string
): string[] {
  const docType = String(documentType || '').trim();
  const family = String(artifactFamily || '').trim();
  const catalog = loadDocumentInferencePolicyCatalog();
  const matched = catalog.profile_rules.find(
    (rule) => rule.document_type === docType || rule.document_type === family
  );
  return matched?.keywords || [];
}
