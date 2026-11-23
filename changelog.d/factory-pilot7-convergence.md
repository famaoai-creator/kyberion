---
category: Changed
---

- **External-operation `delegable` flags are registry-derived.** The 16 call
  sites that hardcoded `delegable: true|false` now call
  `isDelegableExternalOperation(<operationId>)`, and a new
  `delegable-flag-literal` contract test fails on any future bare literal
  outside a reasoned, staleness-checked allowlist (email custom adapters and
  generic service effects remain context-forced by design).
- **Operation egress classes live in the delegation registry.**
  `EXTERNAL_OPERATION_CLASSES` in `external-operation-target.ts` declares
  `tierSource`, `repositoryTarget` and `tenantSystemRead` per operation; the
  admission path no longer carries inline op-id lists, and contract tests pin
  every classified op to a declared registry entry.
- **IO operation classes are canonical projections.** `resource-access-scope.ts`
  exports `isContentMutatingResourceAccessOperation` (write|append),
  `isMutatingResourceAccessOperation` (+mkdir), `isReadLikeResourceAccessOperation`
  (read|metadata) and `isMetadataAncestorAccess`; nine call sites across the
  path guard, tier guard, runtimes and store capabilities use them.
- **`CharterScope` vocabulary moved to `foundation/charter-scope.ts`.** The
  scope union and `isPersonalCharterScope` / `charterScopeTenantSlug` /
  `charterScopesEqual` predicates are re-exported from
  `accountability-charter.ts` unchanged; foundation-layer capabilities can now
  consume them without a layer-direction violation.
- **Custody predicates per union.** `isPerson/Tenant/SystemCustody` for
  `CustodyOwner` and `is*RecordCustody` for `ViewerRecordCustody` replace
  scattered `kind ===` branches in provider egress and surface modules.
- The `union-literal-branch` baseline strictly shrank; validation-edge
  literals that narrow untrusted input remain by design.
