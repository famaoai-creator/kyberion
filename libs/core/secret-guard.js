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
const index_js_1 = require("./index.js");
const pathResolver = __importStar(require("./path-resolver.js"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Sovereign Secret Guard v1.4 [STANDARDIZED]
 * Implements Personal Knowledge Connection Mapping with Secure-IO.
 */
const SECRETS_FILE = pathResolver.resolve('vault/secrets/secrets.json');
const PERSONAL_CONNECTIONS_DIR = pathResolver.resolve('knowledge/personal/connections');
const GRANTS_FILE = pathResolver.resolve('active/shared/auth-grants.json');
const _activeSecrets = new Set();
const _cachedPersonalSecrets = new Map();
/**
 * Loads and maps secrets from personal connection files.
 * Handles both connections/*.json and connections/service/*.json
 */
const _loadPersonalSecrets = () => {
    try {
        const items = (0, index_js_1.safeReaddir)(PERSONAL_CONNECTIONS_DIR);
        for (const item of items) {
            const fullPath = path.join(PERSONAL_CONNECTIONS_DIR, item);
            const stat = (0, index_js_1.safeStat)(fullPath);
            if (stat.isDirectory()) {
                const serviceName = item.toUpperCase();
                const subFiles = (0, index_js_1.safeReaddir)(fullPath).filter(f => f.endsWith('.json'));
                for (const subFile of subFiles) {
                    const content = JSON.parse((0, index_js_1.safeReadFile)(path.join(fullPath, subFile), { encoding: 'utf8' }));
                    _mapContentToSecrets(serviceName, content);
                }
            }
            else if (item.endsWith('.json')) {
                const serviceName = path.basename(item, '.json').toUpperCase();
                const content = JSON.parse((0, index_js_1.safeReadFile)(fullPath, { encoding: 'utf8' }));
                _mapContentToSecrets(serviceName, content);
            }
        }
    }
    catch (_) {
        // Fail silently during boot
    }
};
const _mapContentToSecrets = (serviceName, content) => {
    for (const [key, value] of Object.entries(content)) {
        if (typeof value === 'string') {
            const secretKey = `${serviceName}_${key.toUpperCase()}`;
            _cachedPersonalSecrets.set(secretKey, value);
        }
        else if (typeof value === 'object' && value !== null) {
            _mapContentToSecrets(serviceName, value);
        }
    }
};
// Initial load
_loadPersonalSecrets();
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
    if (scope) {
        const grants = _loadGrants();
        const isPrivileged = currentMission === 'MSN-SYSTEM-NEXUS-DISPATCH' ||
            currentMission === 'MSN-SYSTEM-SENSORY-HUB';
        const activeGrant = grants.find(g => g.missionId === currentMission &&
            g.serviceId.toLowerCase() === scope.toLowerCase() &&
            g.expiresAt > Date.now());
        if (!activeGrant && !isPrivileged) {
            throw new Error(`TIBA_VIOLATION: No active temporal grant for service "${scope}" in mission "${currentMission}". Access Denied.`);
        }
    }
    if (scope && !key.toUpperCase().startsWith(scope.toUpperCase())) {
        throw new Error(`SHIELD_VIOLATION: Key "${key}" does not match authorized scope "${scope}".`);
    }
    let value = process.env[key];
    if (!value) {
        value = _cachedPersonalSecrets.get(key);
    }
    if (!value) {
        try {
            const secrets = JSON.parse((0, index_js_1.safeReadFile)(SECRETS_FILE, { encoding: 'utf8' }));
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
    try {
        const content = (0, index_js_1.safeReadFile)(GRANTS_FILE, { encoding: 'utf8' });
        return JSON.parse(content);
    }
    catch (_) {
        return [];
    }
}
function _saveGrants(grants) {
    // Prune expired grants before saving
    const freshGrants = grants.filter(g => g.expiresAt > Date.now());
    const content = JSON.stringify(freshGrants, null, 2);
    // Use safeWriteFile which handles directories and basic safety
    (0, index_js_1.safeWriteFile)(GRANTS_FILE, content);
    // For physical sync assurance in multi-process (legacy necessity)
    try {
        const fd = fs.openSync(GRANTS_FILE, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
    }
    catch (_) { }
}
const getActiveSecrets = () => Array.from(_activeSecrets);
exports.getActiveSecrets = getActiveSecrets;
exports.secretGuard = { getSecret: exports.getSecret, getActiveSecrets: exports.getActiveSecrets, grantAccess: exports.grantAccess };
