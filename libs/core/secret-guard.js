"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.secretGuard = exports.getActiveSecrets = exports.getSecret = exports.grantAccess = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Sovereign Secret Guard v1.2 [TIBA COMPLIANT]
 * Implements Temporal Intent-Based Authentication.
 */
const SECRETS_FILE = path.join(process.cwd(), 'vault/secrets/secrets.json');
const GRANTS_FILE = path.join(process.cwd(), 'active/shared/auth-grants.json');
const _activeSecrets = new Set();
/**
 * Issued by Orchestrator to authorize a secret for a limited time.
 */
const grantAccess = (missionId, serviceId, ttlMinutes = 15) => {
    const grants = _loadGrants();
    grants.push({
        missionId,
        serviceId: serviceId.toLowerCase(),
        expiresAt: Date.now() + (ttlMinutes * 60 * 1000)
    });
    _saveGrants(grants);
};
exports.grantAccess = grantAccess;
/**
 * Retrieve a secret value, enforcing temporal and intent-based gates.
 */
const getSecret = (key, scope) => {
    const currentMission = process.env.MISSION_ID;
    // TIBA GATE: If scope is provided, verify active grant
    if (scope) {
        const grants = _loadGrants();
        const activeGrant = grants.find(g => g.missionId === currentMission &&
            g.serviceId === scope.toLowerCase() &&
            g.expiresAt > Date.now());
        if (!activeGrant) {
            throw new Error(`TIBA_VIOLATION: No active temporal grant for service "${scope}" in mission "${currentMission}". Access Denied.`);
        }
    }
    // Basic Shield Violation Check (prefix match)
    if (scope && !key.toUpperCase().startsWith(scope.toUpperCase())) {
        throw new Error(`SHIELD_VIOLATION: Key "${key}" does not match authorized scope "${scope}".`);
    }
    let value = process.env[key];
    if (!value && fs.existsSync(SECRETS_FILE)) {
        try {
            const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
            value = secrets[key];
        }
        catch (_) { }
    }
    if (value && typeof value === 'string') {
        if (value.length > 8)
            _activeSecrets.add(value);
        return value;
    }
    return null;
};
exports.getSecret = getSecret;
function _loadGrants() {
    if (!fs.existsSync(GRANTS_FILE))
        return [];
    try {
        return JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8'));
    }
    catch (_) {
        return [];
    }
}
function _saveGrants(grants) {
    const dir = path.dirname(GRANTS_FILE);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    // Prune expired grants before saving
    const freshGrants = grants.filter(g => g.expiresAt > Date.now());
    fs.writeFileSync(GRANTS_FILE, JSON.stringify(freshGrants, null, 2));
}
const getActiveSecrets = () => Array.from(_activeSecrets);
exports.getActiveSecrets = getActiveSecrets;
exports.secretGuard = { getSecret: exports.getSecret, getActiveSecrets: exports.getActiveSecrets, grantAccess: exports.grantAccess };
