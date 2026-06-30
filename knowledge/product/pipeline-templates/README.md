# Pipeline Templates

Canonical user-facing pipeline patterns live here.

## Preflight Rule

Every executable template must include a preflight gate before the first side-effecting step.

Required shape:

- use a reusable fragment under `pipelines/fragments/`
- emit a standard `preflight_result` channel
- keep the preflight step first, or as early as possible after immutable context setup
- fail fast on missing runtime, service auth, browser, media, or meeting prerequisites

Preferred pattern:

```json
{
  "id": "preflight",
  "role": "gate",
  "op": "core:include",
  "params": { "fragment": "fragments/<domain>-preflight.json" }
}
```

Domain-specific templates may layer additional checks, but they should not duplicate the same shell guard logic inline if a shared fragment exists.

## Instantiation

1. Copy the template to `knowledge/confidential/{tenant}/pipelines/{name}.json`
2. Fill in tenant-specific params and secrets
3. Keep the preflight gate intact unless the template is explicitly a non-executable reference
4. Run from the tenant path after validating the preflight contract
