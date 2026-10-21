/** Knowledge sensitivity only; model size and storage partitions are separate vocabularies. */
export const KNOWLEDGE_TIERS = Object.freeze(['public', 'confidential', 'personal'] as const);
export type KnowledgeTier = (typeof KNOWLEDGE_TIERS)[number];
export type TierLevel = KnowledgeTier;
export const KNOWLEDGE_TIER_RANK: Readonly<Record<KnowledgeTier, number>> = Object.freeze({
  public: 0,
  confidential: 1,
  personal: 2,
});
