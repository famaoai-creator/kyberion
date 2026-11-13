---
category: Added
---

- **Tenant hearing templates and objectives (HR-01)** — a tenant can now set its own hearing goals: `pnpm kyberion customer-decision template put --tenant <t> --file <template.json> --by user:<member>` stores a hearing template under the tenant's `decisions/_templates/` (text written inline in ja / en), and `draft --template <id>` uses it before the product template of the same id (`bolt-review` stays product-only). Templates and agendas carry an `objective` (statement and success criteria), set from the template or with `draft --objective <text>|none`; it is shown at the top of the customer-room page and bound into the approved content hash (agendas without one keep their hash). `template list` / `template show` show which template a draft would use. Hearing is now a registered concept (`knowledge/product/architecture/hearing-model.md`). `meeting:hearing_session` also declares the `context` parameter it already used.
