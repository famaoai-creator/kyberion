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
    if (resolvedPath.startsWith(PUBLIC_DIR) && 
        !resolvedPath.startsWith(CONFIDENTIAL_DIR) && 
        !resolvedPath.startsWith(PERSONAL_DIR)) {
        if (role !== 'Ecosystem Architect') {
            return { 
                allowed: false, 
                reason: `Public Write Denied: Only 'Ecosystem Architect' can modify Public Tier assets. Current role: ${role}` 
            };
        }
    }

    // 2. Confidential/Personal Isolation (Architect cannot write)
    if (role === 'Ecosystem Architect') {
        if (resolvedPath.startsWith(CONFIDENTIAL_DIR) || resolvedPath.startsWith(PERSONAL_DIR)) {
            return {
                allowed: false,
                reason: `Confidential/Personal Write Denied: 'Ecosystem Architect' must not write to sensitive tiers. Current role: ${role}`
            };
        }
    }

    return { allowed: true };
}

/**
 * Scan content for potential leaks of sovereign secrets.
 * @param {string} content - The content to be validated.
 * @returns {Object} { safe: boolean, detected: string[] }
 */
function validateSovereignBoundary(content) {
    const findings = [];
    
    // 1. Gather all unique tokens from Personal tier
    const getTokens = (dir) => {
        const tokens = [];
        if (!fs.existsSync(dir)) return tokens;
        
        const files = fs.readdirSync(dir, { recursive: true });
        files.forEach(f => {
            const p = path.join(dir, f);
            if (fs.statSync(p).isFile()) {
                const text = fs.readFileSync(p, 'utf8');
                // Extract API keys, passwords, specific names from personal files
                const matches = text.match(/[A-Za-z0-9\-_]{20,}/g); 
                if (matches) tokens.push(...matches);
            }
        });
        return [...new Set(tokens)];
    };

    const forbiddenTokens = [...getTokens(PERSONAL_DIR), ...getTokens(CONFIDENTIAL_DIR)];

    // 2. Scan the provided content for any of these tokens
    forbiddenTokens.forEach(token => {
        if (content.includes(token)) {
            findings.push(token.substring(0, 4) + '...');
        }
    });

    return {
        safe: findings.length === 0,
        detected: findings
    };
}

module.exports = { validateSovereignBoundary };
