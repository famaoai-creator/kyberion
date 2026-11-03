---
category: Changed
---

- Unify duplicated provider routing and registry machinery behind shared seams infrastructure: OCR, image-generation, and music-generation routers now delegate to `ProviderChainRouter`, and modality-specific provider registries use `createProviderRegistry` with governed `default_chains` policies.
- Add a `secret-provider` seam with a shared provider registry and `selectSecretProvider` (replacing `SecretPolicyRouter`), and migrate embedding-backend ordering into governed `seam-provider-selection` policy while keeping sole-backend stability for vector compatibility.
- Extract `wrapAdapterEffects` for adapter governance proxies (video, image, calendar, email) and migrate all hand-written sole-seam disposer bookkeeping across core to `createSeamLifecycle`.
