---
category: Added
---

- **Link your own IdP account from Concierge** — a member already signed in to Concierge (for example with the first-run access token) can press "Link my account" on `/setup/sso` or right after first-run setup, sign in with the identity provider once, and have that account bound to them. The member comes from the signed-in viewer on the server and travels only inside the HMAC-sealed login transaction. The callback binds only an unbound identity, refuses one that belongs to another member (and does not sign in as them), and never links to a suspended member. Copying `issuer` / `subject` by hand is no longer needed for your own account.
