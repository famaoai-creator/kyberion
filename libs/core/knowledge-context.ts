import {
  assertScopeContext,
  type ScopeContext,
  type ScopeContextInput,
} from './scope-context-validation.js';

export type KnowledgePurpose = 'capture' | 'recall' | 'promote' | 'publish' | 'forget';
export type KnowledgeRetention = 'session' | 'until_distilled' | 'durable' | 'expiry';
export type KnowledgeTrainingUse = 'local_only' | 'zero_retention' | 'training_eligible';

export interface KnowledgeContext extends ScopeContext {
  purpose: KnowledgePurpose;
  retention: KnowledgeRetention;
  training_use: KnowledgeTrainingUse;
  provenance_refs: string[];
  owner_nhi?: string;
  allowed_audience?: string[];
  redacted?: boolean;
}

export interface KnowledgeContextInput extends ScopeContextInput {
  purpose: KnowledgePurpose;
  retention?: KnowledgeRetention;
  training_use?: KnowledgeTrainingUse;
  provenance_refs?: string[];
  owner_nhi?: string;
  allowed_audience?: string[];
  redacted?: boolean;
}

const PURPOSES = new Set<KnowledgePurpose>(['capture', 'recall', 'promote', 'publish', 'forget']);
const RETENTIONS = new Set<KnowledgeRetention>(['session', 'until_distilled', 'durable', 'expiry']);
const TRAINING_USE = new Set<KnowledgeTrainingUse>([
  'local_only',
  'zero_retention',
  'training_eligible',
]);

function cleanList(values: string[] | undefined, label: string): string[] {
  if (!values) return [];
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value)) {
    throw new Error(`[KNOWLEDGE_CONTEXT_INVALID] ${label} contains an empty value`);
  }
  return [...new Set(normalized)];
}

/** Normalize the shared policy envelope before a memory/knowledge adapter acts. */
export function resolveKnowledgeContext(input: KnowledgeContextInput): KnowledgeContext {
  if (!PURPOSES.has(input.purpose)) {
    throw new Error(`[KNOWLEDGE_CONTEXT_INVALID] unsupported purpose '${input.purpose}'`);
  }
  const retention =
    input.retention || (input.purpose === 'capture' ? 'until_distilled' : 'durable');
  if (!RETENTIONS.has(retention)) {
    throw new Error(`[KNOWLEDGE_CONTEXT_INVALID] unsupported retention '${retention}'`);
  }
  const trainingUse = input.training_use || 'local_only';
  if (!TRAINING_USE.has(trainingUse)) {
    throw new Error(`[KNOWLEDGE_CONTEXT_INVALID] unsupported training_use '${trainingUse}'`);
  }
  const scope = assertScopeContext(input, { requireTenant: input.tier === 'confidential' });
  const provenanceRefs = cleanList(input.provenance_refs, 'provenance_refs');
  const audience = cleanList(input.allowed_audience, 'allowed_audience');
  const owner = input.owner_nhi?.trim();
  if (input.purpose === 'publish' && input.tier !== 'public' && input.redacted !== true) {
    throw new Error(
      '[KNOWLEDGE_CONTEXT_INVALID] publishing restricted knowledge requires redaction'
    );
  }
  if (input.tier === 'personal' && !owner && audience.length === 0) {
    throw new Error(
      '[KNOWLEDGE_CONTEXT_INVALID] personal knowledge requires owner_nhi or allowed_audience'
    );
  }
  return {
    ...scope,
    purpose: input.purpose,
    retention,
    training_use: trainingUse,
    provenance_refs: provenanceRefs,
    ...(owner ? { owner_nhi: owner } : {}),
    ...(audience.length ? { allowed_audience: audience } : {}),
    ...(input.redacted !== undefined ? { redacted: input.redacted } : {}),
  };
}

export function canPromoteKnowledge(
  context: KnowledgeContext,
  targetTier: ScopeContext['tier']
): boolean {
  if (context.purpose !== 'promote') return false;
  if (targetTier === 'public') {
    return context.redacted === true && context.provenance_refs.length > 0;
  }
  return targetTier === context.tier || context.tier === 'personal';
}
