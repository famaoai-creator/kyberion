/**
 * scripts/lib/tier-guard.cjs
 * Sovereign Knowledge Protocol Enforcement
 */
const fs = require('fs');
const path = require('path');
const { fileUtils } = require('./core.cjs');

const PERSONAL_DIR = path.resolve(__dirname, '../../knowledge/personal');
const CONFIDENTIAL_DIR = path.resolve(__dirname, '../../knowledge/confidential');
const PUBLIC_DIR = path.resolve(__dirname, '../../knowledge');

/** Numeric weight for each tier (higher = more sensitive). */
const TIERS = {
  personal: 3,
  confidential: 2,
  public: 1,
};

/**
 * Determine the knowledge tier of a file based on its path.
 * @param {string} filePath - Absolute or relative path
 * @returns {'personal'|'confidential'|'public'} The detected tier level
 */
function detectTier(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(PERSONAL_DIR)) return 'personal';
  if (resolved.startsWith(CONFIDENTIAL_DIR)) return 'confidential';
  return 'public';
}

/**
 * Check whether data from sourceTier is allowed to flow into targetTier.
 * @param {string} sourceTier
 * @param {string} targetTier
 * @returns {boolean}
 */
function canFlowTo(sourceTier, targetTier) {
  return (TIERS[sourceTier] || 1) <= (TIERS[targetTier] || 1);
}

/**
 * Scan text content for patterns that suggest sensitive / confidential data.
 * @param {string} content
 * @returns {Object} { hasMarkers: boolean, markers: string[] }
 */
function scanForConfidentialMarkers(content) {
  const MARKERS = [
    /CONFIDENTIAL/i,
    /SECRET/i,
    /PRIVATE/i,
    /API[_-]?KEY/i,
    /PASSWORD/i,
    /TOKEN/i,
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  ];

  const found = [];
  for (const pattern of MARKERS) {
    if (pattern.test(content)) {
      found.push(pattern.source);
    }
  }

  return { hasMarkers: found.length > 0, markers: found };
}

/**
 * Validate if the current role has permission to write to a specific path.
 * Implements GEMINI.md 3.G (Role-Based Write Control).
 *
 * @param {string} targetPath - Absolute or relative path to the file/directory.
 * @returns {Object} { allowed: boolean, reason: string }
 */
function validateWritePermission(targetPath) {
  const role = fileUtils.getCurrentRole();
  const resolvedPath = path.resolve(targetPath);

  // 1. Public Write (Architect Only)
  if (
    resolvedPath.startsWith(PUBLIC_DIR) &&
    !resolvedPath.startsWith(CONFIDENTIAL_DIR) &&
    !resolvedPath.startsWith(PERSONAL_DIR)
  ) {
    if (role !== 'Ecosystem Architect') {
      return {
        allowed: false,
        reason: `Public Write Denied: Only 'Ecosystem Architect' can modify Public Tier assets. Current role: ${role}`,
      };
    }
  }

  // 2. Confidential/Personal Isolation (Architect cannot write)
  if (role === 'Ecosystem Architect') {
    if (resolvedPath.startsWith(CONFIDENTIAL_DIR) || resolvedPath.startsWith(PERSONAL_DIR)) {
      return {
        allowed: false,
        reason: `Confidential/Personal Write Denied: 'Ecosystem Architect' must not write to sensitive tiers. Current role: ${role}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Validate if reading from a path is allowed (Sandbox Security).
 * @param {string} targetPath
 * @returns {Object} { allowed: boolean, reason: string }
 */
function validateReadPermission(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(process.cwd());

  // 1. Stay within Project Root
  if (!resolved.startsWith(root)) {
    return { allowed: false, reason: 'Escape detected: Path is outside project root.' };
  }

  // 2. Block sensitive system directories
  if (resolved.includes('/.git/') || resolved.includes('/.ssh/')) {
    return { allowed: false, reason: 'Access Denied: System directory is protected.' };
  }

  return { allowed: true };
}

/**
 * Validate that a knowledge file can be injected into output at the given tier.
 * @param {string} knowledgePath - Path to the knowledge file
 * @param {string} outputTier    - Target output tier
 * @returns {Object} { allowed, sourceTier, outputTier, reason? }
 */
function validateInjection(knowledgePath, outputTier) {
  const sourceTier = detectTier(knowledgePath);
  const allowed = canFlowTo(sourceTier, outputTier);
  const result = { allowed, sourceTier, outputTier };

  if (!allowed) {
    result.reason = `Cannot inject ${sourceTier}-tier data into ${outputTier}-tier output`;
  }

  return result;
}

/**
 * Scan content for potential leaks of sovereign secrets.
 * Uses an in-memory cache (60s TTL) to avoid re-scanning directories on every call.
 * @param {string} content - The content to be validated.
 * @returns {Object} { safe: boolean, detected: string[] }
 */

// Module-level token cache with TTL
let _sovereignTokenCache = null;
let _sovereignTokenCacheExpiry = 0;
const SOVEREIGN_CACHE_TTL_MS = 60000; // 60 seconds

function _collectTokensFromDir(dir) {
  const tokens = [];
  if (!fs.existsSync(dir)) return tokens;

  const files = fs.readdirSync(dir, { recursive: true });
  files.forEach((f) => {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).isFile()) {
        const text = fs.readFileSync(p, 'utf8');
        // Extract API keys, passwords, specific names from personal files
        const matches = text.match(/[A-Za-z0-9\-_]{20,}/g);
        if (matches) tokens.push(...matches);
      }
    } catch (_e) {
      // Skip files that cannot be read (permissions, encoding, etc.)
    }
  });
  return tokens;
}

function _getForbiddenTokens() {
  const now = Date.now();
  if (_sovereignTokenCache && now < _sovereignTokenCacheExpiry) {
    return _sovereignTokenCache;
  }
  const tokens = [
    ..._collectTokensFromDir(PERSONAL_DIR),
    ..._collectTokensFromDir(CONFIDENTIAL_DIR),
  ];
  _sovereignTokenCache = [...new Set(tokens)];
  _sovereignTokenCacheExpiry = now + SOVEREIGN_CACHE_TTL_MS;
  return _sovereignTokenCache;
}

function validateSovereignBoundary(content) {
  const findings = [];
  const forbiddenTokens = _getForbiddenTokens();

  // Scan the provided content for any of these tokens
  forbiddenTokens.forEach((token) => {
    if (content.includes(token)) {
      findings.push(token.substring(0, 4) + '...');
    }
  });

  return {
    safe: findings.length === 0,
    detected: findings,
  };
}

module.exports = {
  validateSovereignBoundary,
  validateWritePermission,
  validateReadPermission,
  detectTier,
  canFlowTo,
  scanForConfidentialMarkers,
  validateInjection,
};
