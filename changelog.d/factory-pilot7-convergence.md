# factory-pilot7-convergence

Converge scattered conditional branches onto canonical registry-derived
projections, on top of the #1581 durable data model hardening base.

- `delegable` flags at 16 external-operation call sites now derive from
  `isDelegableExternalOperation(...)`; remaining literals are allowlisted
  with reasons and guarded by a new repo-wide contract test.
- Operation egress classes (`tierSource` / `repositoryTarget` /
  `tenantSystemRead`) moved into `EXTERNAL_OPERATION_CLASSES` in the
  delegation registry; the admission path no longer carries inline op-id
  lists. Contract tests pin classified ops to declared operations.
- IO operation classes (`isContentMutating` / `isMutating` / `isReadLike` /
  `isMetadataAncestorAccess`) added to `resource-access-scope.ts` and adopted
  at 9 sites, deduplicating seven scattered `write|append|mkdir` checks and
  the customer-decision metadata-ancestor rule.
- `CharterScope` vocabulary + predicates sank into
  `foundation/charter-scope.ts` (fixes a foundation→domain layering
  inversion); remaining literal branches converted in onboarding, external
  operation runtime and publication store code.
- Custody projections added per union: `isPerson/Tenant/SystemCustody`
  (`CustodyOwner`) and `is*RecordCustody` (`ViewerRecordCustody`), adopted in
  provider egress and surface modules.
- `union-literal-branch-baseline.json` strictly shrunk; no projection
  allowlist entries added.
