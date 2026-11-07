import {
  coreSeamCatalog,
  createSeam,
  createSeamLifecycle,
  type SeamProviderMetadata,
} from '../seam.js';
import { resolveSeamDefaultProvider } from '../provider/seam-provider-selection.js';
import type { KnowledgeContext } from './knowledge-context.js';

export interface KnowledgeRecord {
  id: string;
  content: string;
  content_type?: string;
  title?: string;
  context: KnowledgeContext;
  provenance_refs: string[];
  created_at: string;
  updated_at: string;
}

export interface KnowledgeQuery {
  text: string;
  limit?: number;
  context: KnowledgeContext;
}

export interface KnowledgePromotionCandidate {
  id: string;
  source_record_id: string;
  target_tier: 'personal' | 'confidential' | 'public';
  summary: string;
  evidence_refs: string[];
  requires_approval: boolean;
}

export interface KnowledgeAdapter {
  readonly id: string;
  capture?(record: KnowledgeRecord): Promise<KnowledgeRecord>;
  recall?(query: KnowledgeQuery): Promise<KnowledgeRecord[]>;
  proposePromotion?(
    record: KnowledgeRecord,
    targetTier: KnowledgePromotionCandidate['target_tier']
  ): Promise<KnowledgePromotionCandidate>;
  publish?(record: KnowledgeRecord): Promise<{ id: string; verified: boolean }>;
  archive?(record: KnowledgeRecord): Promise<{ id: string; archived: boolean }>;
  forget?(record: KnowledgeRecord): Promise<{ id: string; forgotten: boolean }>;
}

const knowledgeAdapterSeam = createSeam<KnowledgeAdapter>({
  key: 'knowledge-adapter',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/knowledge/knowledge-adapter.ts',
});

const registrations = createSeamLifecycle(knowledgeAdapterSeam);

export function registerKnowledgeAdapter(
  adapter: KnowledgeAdapter,
  metadata: SeamProviderMetadata = {
    provenance: 'plugin',
    source: 'knowledge-adapter-extension',
  }
): () => void {
  const id = adapter.id.trim();
  if (!id) throw new Error('KnowledgeAdapter.id is required');
  return registrations.register(id, adapter, metadata);
}

/**
 * `id` wins; without one, a registered saved seam default
 * (`seam select default knowledge-adapter=<id>`) or governed policy default
 * is used, else the seam's own rule (the single registered adapter; ambiguous
 * when several are registered).
 */
export function resolveKnowledgeAdapter(id?: string): KnowledgeAdapter {
  if (id) return knowledgeAdapterSeam.get(id);
  const registered = new Set(knowledgeAdapterSeam.list().map((entry) => entry.id));
  const fallback =
    registered.size > 0
      ? resolveSeamDefaultProvider('knowledge-adapter', {
          eligible: (candidate) => registered.has(candidate),
        })
      : null;
  return knowledgeAdapterSeam.get(fallback?.provider);
}

export function listKnowledgeAdapters(): KnowledgeAdapter[] {
  return knowledgeAdapterSeam.list().map((entry) => entry.implementation);
}
