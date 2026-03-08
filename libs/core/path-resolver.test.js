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
const vitest_1 = require("vitest");
const path = __importStar(require("node:path"));
const path_resolver_js_1 = require("./path-resolver.js");
(0, vitest_1.describe)('path-resolver core', () => {
    (0, vitest_1.it)('should find the project root', () => {
        const root = (0, path_resolver_js_1.rootDir)();
        (0, vitest_1.expect)(root).toBeDefined();
        (0, vitest_1.expect)(root.endsWith('github')).toBe(true);
        (0, vitest_1.expect)(path.isAbsolute(root)).toBe(true);
    });
    (0, vitest_1.it)('should resolve skill directory via index or default path', () => {
        const dir = (0, path_resolver_js_1.skillDir)('security-scanner');
        (0, vitest_1.expect)(dir).toContain('security-scanner');
        (0, vitest_1.expect)(path.isAbsolute(dir)).toBe(true);
    });
    (0, vitest_1.it)('should resolve logical skill:// protocol', () => {
        const logical = 'skill://security-scanner/src/index.ts';
        const physical = (0, path_resolver_js_1.resolve)(logical);
        (0, vitest_1.expect)(physical).toContain('security-scanner');
        (0, vitest_1.expect)(physical.endsWith('src/index.ts')).toBe(true);
        (0, vitest_1.expect)(path.isAbsolute(physical)).toBe(true);
    });
    (0, vitest_1.it)('should handle absolute paths correctly', () => {
        const abs = '/tmp/test-path-resolver';
        (0, vitest_1.expect)((0, path_resolver_js_1.resolve)(abs)).toBe(abs);
    });
    (0, vitest_1.it)('should resolve relative paths against project root', () => {
        const rel = 'knowledge/README.md';
        const physical = (0, path_resolver_js_1.resolve)(rel);
        (0, vitest_1.expect)(physical).toBe(path.join((0, path_resolver_js_1.rootDir)(), rel));
    });
});
//# sourceMappingURL=path-resolver.test.js.map