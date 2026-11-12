Tenant service credentials now bind to the selected connection and owner rather than only a
service-level secret name. Explicit personal-to-tenant allocation uses owner-approved, scoped
standing grants and a configured provenance-aware broker; personal ownership is not transferred.
Legacy reasoning credential brokers remain supported. See the service integration guide for
broker version 2 and migration requirements; no grants or secrets are provisioned automatically.
