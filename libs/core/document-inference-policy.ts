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

const FALLBACK_CATALOG: DocumentInferencePolicyCatalog = {
  version: '1.0.0',
  type_rules: [
    {
      document_type: 'meeting-notes',
      keywords: ['minutes', 'meeting', 'agenda', 'attendees', 'action items', 'decision'],
    },
    {
      document_type: 'proposal',
      keywords: ['proposal', 'pitch', 'vision', 'charter', 'commitment'],
    },
    {
      document_type: 'specification',
      keywords: [
        'specification',
        'requirements',
        'brd',
        'api',
        'architecture',
        'design',
        'icd',
        'data dictionary',
        'use case',
      ],
    },
    {
      document_type: 'report',
      keywords: [
        'report',
        'summary',
        'weekly',
        'milestone',
        'closure',
        'audit',
        'security',
        'postmortem',
      ],
    },
    {
      document_type: 'plan',
      keywords: ['plan', 'test', 'qa', 'strategy', 'roadmap', 'runbook', 'release', 'governance'],
    },
    {
      document_type: 'contract',
      keywords: ['contract', 'agreement', 'msa', 'dpa', 'licensing', 'terms', 'service agreement'],
    },
    {
      document_type: 'record',
      keywords: ['log', 'register', 'issue', 'lessons learned', 'stakeholder'],
    },
  ],
  profile_rules: [
    {
      document_type: 'proposal',
      profile_ids: ['executive-proposal', 'vision-proposal', 'project-charter'],
      keywords: ['proposal', 'pitch', 'vision', 'charter', 'decision', 'next step', 'commitment'],
    },
    {
      document_type: 'report',
      profile_ids: [
        'summary-report',
        'weekly-status-report',
        'milestone-report',
        'project-closure-report',
        'security-audit-report',
        'test-validation-report',
      ],
      keywords: [
        'report',
        'summary',
        'weekly',
        'milestone',
        'closure',
        'audit',
        'security',
        'postmortem',
      ],
    },
    {
      document_type: 'plan',
      profile_ids: [
        'test-plan',
        'quality-assurance-strategy',
        'master-test-plan',
        'project-management-plan',
        'risk-management-plan',
        'quality-management-plan',
      ],
      keywords: ['plan', 'test', 'qa', 'strategy', 'roadmap', 'runbook', 'release', 'governance'],
    },
    {
      document_type: 'specification',
      profile_ids: [
        'requirements-definition',
        'business-requirements-document',
        'api-specification',
        'detailed-design',
        'basic-design',
        'interface-control-document',
        'database-design',
        'use-case-specification',
        'data-dictionary',
      ],
      keywords: [
        'spec',
        'specification',
        'requirements',
        'brd',
        'api',
        'architecture',
        'design',
        'icd',
        'data dictionary',
        'use case',
      ],
    },
    {
      document_type: 'meeting-notes',
      profile_ids: [
        'meeting-minutes',
        'mission-ledger',
        'stakeholder-register',
        'issue-log',
        'change-log',
        'lessons-learned-register',
      ],
      keywords: [
        'minutes',
        'meeting',
        'agenda',
        'attendees',
        'action items',
        'decision',
        'issues',
        'register',
        'log',
      ],
    },
    {
      document_type: 'record',
      profile_ids: [
        'meeting-minutes',
        'mission-ledger',
        'stakeholder-register',
        'issue-log',
        'change-log',
        'lessons-learned-register',
      ],
      keywords: [
        'minutes',
        'meeting',
        'agenda',
        'attendees',
        'action items',
        'decision',
        'issues',
        'register',
        'log',
      ],
    },
    {
      document_type: 'contract',
      profile_ids: [
        'master-services-agreement',
        'data-processing-agreement-dpa',
        'ip-licensing-agreement',
        'internal-control-policy',
      ],
      keywords: ['contract', 'agreement', 'msa', 'dpa', 'licensing', 'terms', 'service agreement'],
    },
  ],
};

const catalog = defineCatalog<DocumentInferencePolicyCatalog>({
  id: 'document-inference-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
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

export function resetDocumentInferencePolicyCatalogCache(): void {
  catalog.reset();
}
