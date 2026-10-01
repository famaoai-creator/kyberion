---
category: Added
---

- **Invite people into an organization** — owners (and approvers, for operator/viewer) create a one-time join link from 設定 › 組織とメンバー › 招待. The link opens `/join`, which shows the organization, the role and what that role can see before the person confirms. The invite is a one-time grant to an identity the server has already verified (an existing member, or a verified OIDC subject who becomes a new member), never a credential: the code alone shows nothing. Codes are stored as a hash, single-use, expiring (default 72h), revocable, and every change lands in a per-organization ledger. Nobody can invite an owner.
