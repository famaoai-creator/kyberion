import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';
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
});

const registeredDisposers = new Map<string, () => void>();

export function registerKnowledgeAdapter(
  adapter: KnowledgeAdapter,
  metadata: SeamProviderMetadata = { provenance: 'builtin', source: 'knowledge-adapter' }
): () => void {
  const id = adapter.id.trim();
  if (!id) throw new Error('KnowledgeAdapter.id is required');
  registeredDisposers.get(id)?.();
  const dispose = knowledgeAdapterSeam.register(id, adapter, metadata);
  registeredDisposers.set(id, dispose);
  return () => {
    dispose();
    if (registeredDisposers.get(id) === dispose) registeredDisposers.delete(id);
  };
}

export function resolveKnowledgeAdapter(id?: string): KnowledgeAdapter {
  return knowledgeAdapterSeam.get(id);
}

export function listKnowledgeAdapters(): KnowledgeAdapter[] {
  return knowledgeAdapterSeam.list().map((entry) => entry.implementation);
}
