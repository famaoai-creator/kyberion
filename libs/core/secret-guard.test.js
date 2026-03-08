"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const core_1 = require("@agent/core");
(0, vitest_1.describe)('secret-guard core', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.stubEnv('TEST_SECRET_KEY', 'super-secret-value-123');
    });
    (0, vitest_1.it)('should retrieve secrets from environment variables', () => {
        const val = (0, core_1.getSecret)('TEST_SECRET_KEY');
        (0, vitest_1.expect)(val).toBe('super-secret-value-123');
    });
    (0, vitest_1.it)('should register retrieved secrets for masking', () => {
        (0, core_1.getSecret)('TEST_SECRET_KEY');
        const secrets = (0, core_1.getActiveSecrets)();
        (0, vitest_1.expect)(secrets).toContain('super-secret-value-123');
    });
    (0, vitest_1.it)('should detect registered secrets via validateSovereignBoundary', () => {
        (0, core_1.getSecret)('TEST_SECRET_KEY');
        const content = 'The secret is super-secret-value-123 inside log.';
        const result = (0, core_1.validateSovereignBoundary)(content, (0, core_1.getActiveSecrets)());
        (0, vitest_1.expect)(result.safe).toBe(false);
        (0, vitest_1.expect)(result.detected.some(d => d.includes('SECRET_LEAK'))).toBe(true);
    });
    (0, vitest_1.it)('should identify secret paths correctly', () => {
        (0, vitest_1.expect)((0, core_1.isSecretPath)('vault/secrets/keys.json')).toBe(true);
        (0, vitest_1.expect)((0, core_1.isSecretPath)('skills/core/index.ts')).toBe(false);
    });
});
//# sourceMappingURL=secret-guard.test.js.map