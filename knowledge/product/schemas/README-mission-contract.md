# Mission Contract

`schemas/mission-contract.schema.json` describes a single actuator-dispatchable contract
inside a mission (not the whole `mission-state.json` — see `mission-state.schema.json` for that).
Generated TypeScript: `libs/core/src/types/mission-contract.ts` (`pnpm generate:types`).

## `knowledge_injections` — declare scope, not paths

`knowledge_injections` is a declarative list of the knowledge this mission draws on. Each entry
declares a **tier** directly instead of a literal file path:

```json
"knowledge_injections": [
  { "tier": "public", "domains": ["design-patterns"], "tags": ["pptx"] },
  { "tier": "confidential", "project": "acme-corp", "tags": ["browser-automation"] }
]
```

- `tier` (required): `personal` | `confidential` | `public`. Drives mission tier
  auto-elevation directly — `calculateRequiredTier` (`scripts/refactor/mission-state.ts`) reads
  this field, it does not sniff a path. If any entry's tier outweighs the requested tier, the
  mission's own execution tier is raised to match (see "ミッション・ティアの継承" in
  [knowledge-protocol.md](../governance/knowledge-protocol.md)).
- `project` — required scoping when `tier` is `confidential`; matches
  `knowledge/confidential/{project}/`.
- `domains` / `tags` — used at runtime to resolve which files actually match, via
  `knowledge-index.ts`'s scoped search (`KnowledgeScope`) or the `knowledge/product/hints/*.json`
  tag catalog. Not resolved at template-authoring time.

**Why tier+tags instead of a literal path**: a hardcoded path (the pre-2026-07 shape) goes stale
the moment `knowledge/` is reorganized — this happened twice (`mission-governance.ts`'s
`syncRoleProcedure` and `docs/GLOSSARY.md`'s `KnowledgeHint` path both drifted after a
`product`/`public` reorg and were only caught by manual audit). Declaring tier+tags survives a
directory move; only the runtime resolver needs to know the new physical layout.

As of 2026-07-23 no mission template in `mission-templates.json` populates this field yet — it's
available for template authors adding tier-aware, workflow-scoped knowledge to a mission type.
