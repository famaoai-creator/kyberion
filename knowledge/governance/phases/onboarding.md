# Phase: Onboarding
## Goal
Environment safety verification and identity synchronization.

## Directives
1.  **Identity Verification**: Check for the existence of `knowledge/personal/my-identity.json`.
2.  **Environment Scan**: Verify ecosystem initialization state (Tier directories, core libraries).
3.  **Bootstrap**: Utilize `dist/scripts/bootstrap.js` to establish references to `@agent/core`.
4.  **Infrastructure First**: Do not proceed with high-level tasks if the TypeScript build pipeline (`dist/`) is unstable.

## Constraints
- **Read-Only Mentality**: During initial onboarding, prefer observation over modification until the environment is confirmed safe.
- **Concierge Priority**: Onboarding MUST be led by the Sovereign Concierge to establish foundational mission context.
