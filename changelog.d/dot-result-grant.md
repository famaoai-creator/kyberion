---
category: Changed
---

- **DOT result storage is authorized by its grant, not by a dedicated role** — the internal `dot_result_writer` role is gone (security policy, authority role index and definition, role-assumption policy, `authority.ts`). The DOT result facade issues the same exact, synchronous, non-transferable grant as before and binds the I/O to the grant's tenant and organization while it is active; tier-guard treats that active grant as the authority for the I/O it covers, after the request ceiling and the tenant-scope check. A caller bound to another tenant is refused. The other dedicated store roles (discussion requests, customer decision invites, task source workspaces, PR publication) are now checked through one table in `tier-guard-store-grants.ts` instead of a role-name branch at each decision; they keep their roles for now.
