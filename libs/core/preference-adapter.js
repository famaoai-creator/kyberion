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
exports.preferenceAdapter = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * User Preference Adapter v1.0
 */
const PREF_PATH = path.join(process.cwd(), 'knowledge/personal/user-preferences.json');
exports.preferenceAdapter = {
    get: (key, defaultValue = null) => {
        try {
            if (!fs.existsSync(PREF_PATH))
                return defaultValue;
            const prefs = JSON.parse(fs.readFileSync(PREF_PATH, 'utf8'));
            const parts = key.split('.');
            let current = prefs;
            for (const part of parts) {
                if (current[part] === undefined)
                    return defaultValue;
                current = current[part];
            }
            return current;
        }
        catch (_e) {
            return defaultValue;
        }
    },
    set: (key, value) => {
        try {
            const prefs = fs.existsSync(PREF_PATH) ? JSON.parse(fs.readFileSync(PREF_PATH, 'utf8')) : {};
            const parts = key.split('.');
            let current = prefs;
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                if (!current[part])
                    current[part] = {};
                current = current[part];
            }
            current[parts[parts.length - 1]] = value;
            fs.writeFileSync(PREF_PATH, JSON.stringify(prefs, null, 2) + '\n');
            return true;
        }
        catch (_e) {
            return false;
        }
    },
    forSkill: (skillName) => {
        return exports.preferenceAdapter.get(skillName, {});
    },
};
//# sourceMappingURL=preference-adapter.js.map