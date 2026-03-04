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
exports.secretGuard = exports.isSecretPath = exports.getActiveSecrets = exports.getSecret = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Sovereign Secret Guard v1.0
 */
const SECRETS_FILE = path.join(process.cwd(), 'vault/secrets/secrets.json');
const _activeSecrets = new Set();
const getSecret = (key) => {
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
const getActiveSecrets = () => Array.from(_activeSecrets);
exports.getActiveSecrets = getActiveSecrets;
const isSecretPath = (filePath) => {
    const resolved = path.resolve(filePath);
    return resolved.startsWith(path.join(process.cwd(), 'vault/secrets'));
};
exports.isSecretPath = isSecretPath;
exports.secretGuard = { getSecret: exports.getSecret, getActiveSecrets: exports.getActiveSecrets, isSecretPath: exports.isSecretPath };
//# sourceMappingURL=secret-guard.js.map