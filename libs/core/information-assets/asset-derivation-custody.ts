// Derivation custody vocabulary: the leaf module both the derivation store
// and its read-capability can import without closing a dependency cycle.
export type DerivationCustody =
  { kind: 'system' } | { kind: 'tenant'; ref: string } | { kind: 'person'; ref?: string };

export function isTenantDerivationCustody(
  custody: DerivationCustody
): custody is Extract<DerivationCustody, { kind: 'tenant' }> {
  return custody.kind === 'tenant';
}

export function isPersonDerivationCustody(
  custody: DerivationCustody
): custody is Extract<DerivationCustody, { kind: 'person' }> {
  return custody.kind === 'person';
}

export function isSystemDerivationCustody(
  custody: DerivationCustody
): custody is Extract<DerivationCustody, { kind: 'system' }> {
  return custody.kind === 'system';
}
