"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.secureFetch = secureFetch;
const axios_1 = __importDefault(require("axios"));
const secret_guard_js_1 = require("./secret-guard.js");
/**
 * Standardized network utilities for Kyberion Components.
 * Enhanced with TIBA (Temporal Intent-Based Authentication) and Endpoint Whitelisting.
 */
const ENDPOINT_WHITELIST = {
    'moltbook': ['www.moltbook.com', 'api.moltbook.com'],
    'slack': ['slack.com', 'api.slack.com'],
    'github': ['github.com', 'api.github.com'],
    'google': ['googleapis.com', 'google.com']
};
function scrubData(data, url) {
    if (!data)
        return data;
    let str = typeof data === 'string' ? data : JSON.stringify(data);
    // Layer 2 Shield: Scrub active secrets tracked by secret-guard
    const secrets = secret_guard_js_1.secretGuard.getActiveSecrets();
    for (const secret of secrets) {
        if (secret && secret.length > 5) {
            // Endpoint Check: If the URL is whitelisted for a service, we might allow the secret 
            // (This is handled primarily in headers, but we scrub body just in case)
            const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            str = str.replace(new RegExp(escaped, 'g'), '[REDACTED_SECRET]');
        }
    }
    // Scrub absolute local paths
    str = str.replace(/\/Users\/[a-zA-Z0-9._-]+\//g, '[REDACTED_PATH]/');
    return typeof data === 'string' ? str : JSON.parse(str);
}
async function secureFetch(options) {
    const url = options.url || '';
    const hostname = new URL(url).hostname;
    // 1. Verify Endpoint Integrity
    // If the request contains sensitive keywords in headers but target is not whitelisted, reject.
    const hasAuth = options.headers && (options.headers['Authorization'] || options.headers['X-API-KEY']);
    if (hasAuth) {
        let isWhitelisted = false;
        for (const service in ENDPOINT_WHITELIST) {
            if (ENDPOINT_WHITELIST[service].some(domain => hostname.endsWith(domain))) {
                isWhitelisted = true;
                break;
            }
        }
        if (!isWhitelisted) {
            throw new Error(`TIBA_SECURITY_VIOLATION: Attempted authenticated request to non-whitelisted endpoint: ${hostname}`);
        }
    }
    // 2. Automatically scrub outbound payload
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
