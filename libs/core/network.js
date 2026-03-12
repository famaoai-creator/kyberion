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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.secureFetch = secureFetch;
const axios_1 = __importDefault(require("axios"));
const secret_guard_js_1 = require("./secret-guard.js");
const path_resolver_js_1 = require("./path-resolver.js");
const fs = __importStar(require("node:fs"));

/**
 * Standardized network utilities for Kyberion Components.
 * v2.2 - POLICY-DRIVEN GUARDRAILS (ADF ENABLED)
 */

function loadAllowedDomains() {
    try {
        const policyPath = (0, path_resolver_js_1.knowledge)('public/governance/security-policy.json');
        if (fs.existsSync(policyPath)) {
            const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
            return policy.network_guardrails.allowed_domains || [];
        }
    }
    catch (_) { }
    return ['github.com', 'google.com']; // Hard fallback
}

function scrubData(data, url) {
    if (!data)
        return data;
    let str = typeof data === 'string' ? data : JSON.stringify(data);
    const secrets = (0, secret_guard_js_1.getActiveSecrets)();
    for (const secret of secrets) {
        if (secret && secret.length > 5) {
            const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            str = str.replace(new RegExp(escaped, 'g'), '[REDACTED_SECRET]');
        }
    }
    str = str.replace(/\/Users\/[a-zA-Z0-9._-]+\//g, '[REDACTED_PATH]/');
    return typeof data === 'string' ? str : JSON.parse(str);
}

async function secureFetch(options) {
    const url = options.url || '';
    const hostname = new URL(url).hostname;
    const hasAuth = options.headers && (options.headers['Authorization'] || options.headers['X-API-KEY']);
    if (hasAuth) {
        const allowedDomains = loadAllowedDomains();
        const isWhitelisted = allowedDomains.some(domain => hostname.endsWith(domain));
        if (!isWhitelisted) {
            throw new Error(`[NETWORK_POLICY_VIOLATION] Authenticated request to non-whitelisted domain: ${hostname}`);
        }
    }
    if (options.data)
        options.data = scrubData(options.data, url);
    if (options.params)
        options.params = scrubData(options.params, url);
    try {
        const response = await (0, axios_1.default)({
            timeout: 15000,
            headers: {
                'User-Agent': 'Kyberion-Sovereign-Agent/2.1.0 (Physical-Integrity-Enforced)',
            },
            ...options,
        });
        return response.data;
    }
    catch (err) {
        const status = err.response ? ` (${err.response.status})` : '';
        throw new Error(`Network Error: ${err.message}${status}`);
    }
}
