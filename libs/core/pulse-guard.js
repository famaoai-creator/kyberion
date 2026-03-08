"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pulseGuard = void 0;
const node_crypto_1 = require("node:crypto");
const secret_guard_js_1 = require("./secret-guard.js");
/**
 * Pulse Guard: Ensures Stimuli Integrity via HMAC.
 * [SECRET-GUARD COMPLIANT VERSION]
 */
exports.pulseGuard = {
    sign: (payload) => {
        const secret = secret_guard_js_1.secretGuard.getSecret('GEMINI_SOVEREIGN_SECRET') || 'default-secret';
        const hmac = (0, node_crypto_1.createHmac)('sha256', secret).update(payload).digest('hex');
        return hmac;
    },
    verify: (payload, signature) => {
        try {
            const secret = secret_guard_js_1.secretGuard.getSecret('GEMINI_SOVEREIGN_SECRET') || 'default-secret';
            const expectedHmac = (0, node_crypto_1.createHmac)('sha256', secret).update(payload).digest('hex');
            return expectedHmac === signature;
        }
        catch (_) {
            return false;
        }
    }
};
//# sourceMappingURL=pulse-guard.js.map