---
category: Added
---

- **Forge-agnostic change-request ownership on WorkItems** — `pnpm work link-change` binds a PR / MR / Gerrit change / branch to the WorkItem whose claim the caller holds, `pnpm work change-owner` answers which agent currently owns a change request (by branch, or forge + ref), `pnpm work update-change` records merged/closed observations, and `pnpm work list-changes` lists the bindings. No forge API is called: the branch is the join key, and forge/ref/url are opaque labels. A branch links to at most one unfinished item, and only the live claim holder may link.
