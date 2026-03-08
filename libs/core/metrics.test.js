"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const metrics_js_1 = require("./metrics.js");
(0, vitest_1.describe)('metrics core', () => {
    (0, vitest_1.it)('should record and summarize aggregates correctly', () => {
        const mc = new metrics_js_1.MetricsCollector({ persist: false });
        mc.record('test-skill-a', 100, 'success');
        mc.record('test-skill-a', 200, 'success');
        mc.record('test-skill-a', 50, 'error');
        mc.record('test-skill-b', 300, 'success');
        const summaries = mc.summarize();
        (0, vitest_1.expect)(Array.isArray(summaries)).toBe(true);
        (0, vitest_1.expect)(summaries).toHaveLength(2);
        const skillA = summaries.find((s) => s.skill === 'test-skill-a');
        (0, vitest_1.expect)(skillA).toBeDefined();
        (0, vitest_1.expect)(skillA.executions).toBe(3);
        (0, vitest_1.expect)(skillA.errors).toBe(1);
        (0, vitest_1.expect)(skillA.errorRate).toBe(33.3);
        (0, vitest_1.expect)(skillA.avgMs).toBe(117);
        (0, vitest_1.expect)(skillA.minMs).toBe(50);
        (0, vitest_1.expect)(skillA.maxMs).toBe(200);
        const skillB = summaries.find((s) => s.skill === 'test-skill-b');
        (0, vitest_1.expect)(skillB).toBeDefined();
        (0, vitest_1.expect)(skillB.executions).toBe(1);
        (0, vitest_1.expect)(skillB.errors).toBe(0);
    });
    (0, vitest_1.it)('should return detailed metrics for a recorded skill', () => {
        const mc = new metrics_js_1.MetricsCollector({ persist: false });
        mc.record('my-skill', 150, 'success');
        mc.record('my-skill', 250, 'error');
        const result = mc.getSkillMetrics('my-skill');
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.count).toBe(2);
        (0, vitest_1.expect)(result.errors).toBe(1);
        (0, vitest_1.expect)(result.minMs).toBe(150);
        (0, vitest_1.expect)(result.maxMs).toBe(250);
        (0, vitest_1.expect)(result.totalMs / result.count).toBe(200);
        (0, vitest_1.expect)(typeof result.lastRun).toBe('string');
    });
    (0, vitest_1.it)('should capture peak memory values', () => {
        const mc = new metrics_js_1.MetricsCollector({ persist: false });
        mc.record('mem-test', 100, 'success');
        mc.record('mem-test', 200, 'success');
        const result = mc.getSkillMetrics('mem-test');
        (0, vitest_1.expect)(result.peakHeapMB).toBeGreaterThan(0);
        (0, vitest_1.expect)(result.peakRssMB).toBeGreaterThan(0);
        (0, vitest_1.expect)(result.peakRssMB).toBeGreaterThanOrEqual(result.peakHeapMB);
    });
    (0, vitest_1.it)('should return null for an unknown skill', () => {
        const mc = new metrics_js_1.MetricsCollector({ persist: false });
        const result = mc.getSkillMetrics('nonexistent-skill');
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)('should clear aggregates on reset', () => {
        const mc = new metrics_js_1.MetricsCollector({ persist: false });
        mc.record('reset-test', 100, 'success');
        (0, vitest_1.expect)(mc.summarize()).toHaveLength(1);
        mc.reset();
        (0, vitest_1.expect)(mc.summarize()).toHaveLength(0);
        (0, vitest_1.expect)(mc.getSkillMetrics('reset-test')).toBeNull();
    });
});
//# sourceMappingURL=metrics.test.js.map