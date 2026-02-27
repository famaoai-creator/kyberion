const fs = require('fs');
const path = require('path');
const { detectTier } = require('./tier-guard.cjs');

/**
 * Sovereign Secret Guard v1.0
 * Provides governed access to secrets and ensures they are masked in outputs.
 */

const rootDir = path.resolve(__dirname, '../..');
const SECRETS_FILE = path.join(rootDir, 'vault/secrets/secrets.json');

// Memory cache for registered secrets to be masked
const _activeSecrets = new Set();

const secretGuard = {
  /**
   * Retrieve a secret by key from vault or environment.
   * Automatically registers the value for output masking.
   *
   * @param {string} key - Secret key (e.g. 'OPENAI_API_KEY')
   * @returns {string|null} The secret value
   */
  getSecret: (key) => {
    let value = process.env[key];

    // Try vault/secrets/secrets.json if not in env
    if (!value && fs.existsSync(SECRETS_FILE)) {
      try {
        const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
        value = secrets[key];
      } catch (_e) {
        /* ignore */
      }
    }

    if (value && typeof value === 'string') {
      // Register for masking if it looks sensitive (long enough)
      if (value.length > 8) {
        _activeSecrets.add(value);
      }
      return value;
    }

    return null;
  },

  /**
   * Get all currently active secrets (for tier-guard integration)
   */
  getActiveSecrets: () => Array.from(_activeSecrets),

  /**
   * Check if a path is a protected secrets area
   */
  isSecretPath: (filePath) => {
    const resolved = path.resolve(filePath);
    return resolved.startsWith(path.join(rootDir, 'vault/secrets'));
  },
};

module.exports = secretGuard;
