/** Canonical identifiers for operations that may require human approval. */
export const RISKY_OPS = {
  SECRET_GRANT_ACCESS: 'secret:grant_access',
  AUTH_GRANT_AUTHORITY: 'auth:grant_authority',
  CONFIG_UPDATE: 'config:update',
  VAULT_WRITE: 'vault:write',
  CLAUDE_BROWSER_INTERACTIVE: 'claude:browser_interactive',
  CLAUDE_DOCUMENT_GENERATION: 'claude:document_generation',
  BROWSER_EXTENSION_EXECUTE: 'browser:extension_execute',
  DESKTOP_DESTRUCTIVE_ACTION: 'desktop:destructive_action',
} as const;

export type RiskyOpId = (typeof RISKY_OPS)[keyof typeof RISKY_OPS];
