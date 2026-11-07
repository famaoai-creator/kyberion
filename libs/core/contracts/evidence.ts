/**
 * Shared evidence metadata for actuator results.
 *
 * REA-derived contract: an op result separates what was observed from what
 * was inferred, names the authority behind its claims, and keeps unresolved
 * aspects as explicit unknowns rather than implying absence.
 */

export type EvidenceConfidence = 'observed' | 'derived' | 'inferred';

export type EvidenceAuthority =
  | 'shipped-artifact'
  | 'controlled-replay'
  | 'historical-reference'
  | 'external-service'
  | 'analyst-inference';

export interface EvidenceMeta {
  /** observed = direct measurement; derived = computed from observations; inferred = reasoning judgment. */
  confidence: EvidenceConfidence;
  /** The channel the claims rest on — e.g. shipped-artifact (the artifact itself) vs analyst-inference. */
  authority: EvidenceAuthority;
  /** Coverage limits a consumer must weigh before relying on the result. */
  limitations: string[];
  /** Aspects that remain unresolved rather than absent. */
  unknowns: string[];
}
