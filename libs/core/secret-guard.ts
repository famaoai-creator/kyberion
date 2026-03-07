import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Sovereign Secret Guard v1.1
 * Part of Layer 2 (Shield) - Enforces Least Privilege access to credentials.
 */

const SECRETS_FILE = path.join(process.cwd(), 'vault/secrets/secrets.json');
const _activeSecrets = new Set<string>();

/**
 * Retrieve a secret value, optionally scoped to a specific service or domain.
 * @param key   - The name of the secret (e.g., 'SLACK_TOKEN')
 * @param scope - (Optional) The service ID requesting the secret (e.g., 'slack')
 */
export const getSecret = (key: string, scope?: string): string | null => {
  // Layer 2 Guard: Enforce prefix-based access control if scope is provided
  if (scope && !key.toUpperCase().startsWith(scope.toUpperCase())) {
    throw new Error(`SHIELD_VIOLATION: Scope "${scope}" is not authorized to access secret key "${key}".`);
  }

  let value = process.env[key];

  if (!value && fs.existsSync(SECRETS_FILE)) {
    try {
      const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
      value = secrets[key];
    } catch (_) {}
  }

  if (value && typeof value === 'string') {
    // Register for outbound scrubbing (Layer 2 Shield)
    if (value.length > 8) _activeSecrets.add(value);
    return value;
  }
  return null;
};

export const getActiveSecrets = () => Array.from(_activeSecrets);

export const isSecretPath = (filePath: string) => {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(path.join(process.cwd(), 'vault/secrets'));
};

export const secretGuard = { getSecret, getActiveSecrets, isSecretPath };
