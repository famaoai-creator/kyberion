---
category: Added
---

- **provider-transport seam** — `libs/core/provider-transport.ts` adds the Layer-3 distributed-runtime transport contract (`invoke` envelope + stable error codes + optional health probe) on the shared provider-registry seam. The governed default `loopback` resolves providers on `coreSeamCatalog` and invokes in-process (zero serialization, local_first preserved); `createRemoteProviderFacade()` lets a capability seam register `provider:remote-x` facades that call through the transport transparently. Remote transports (http/grpc/worker-rpc) land as governed `default_chains` providers — never call-site conditionals.
