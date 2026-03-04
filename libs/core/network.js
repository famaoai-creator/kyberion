"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.secureFetch = secureFetch;
const axios_1 = __importDefault(require("axios"));
/**
 * Standardized network utilities for Gemini Skills.
 */
async function secureFetch(options) {
    try {
        const response = await (0, axios_1.default)({
            timeout: 10000,
            headers: {
                'User-Agent': 'Gemini-Agent/1.0.0',
            },
            ...options,
        });
        return response.data;
    }
    catch (err) {
        throw new Error(`Network Error: ${err.message}${err.response ? ` (${err.response.status})` : ''}`);
    }
}
//# sourceMappingURL=network.js.map