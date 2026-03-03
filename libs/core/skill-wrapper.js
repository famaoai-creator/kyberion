"use strict";
/**
 * TypeScript version of skill-wrapper.
 * Provides typed wrappers for skill execution with standardized output.
 *
 * Usage:
 *   import { runSkill } from '../../scripts/lib/skill-wrapper.js';
 *   runSkill<MyResult>('my-skill', () => ({ result: 'data' }));
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAsyncSkill = void 0;
exports.wrapSkill = wrapSkill;
exports.wrapSkillAsync = wrapSkillAsync;
exports.runSkill = runSkill;
exports.runSkillAsync = runSkillAsync;
const metrics_js_1 = require("./metrics.js");
function buildOutput(skillName, status, dataOrError, startTime) {
    const durationMs = Date.now() - startTime;
    const base = {
        skill: skillName,
        status,
        metadata: {
            duration_ms: durationMs,
            timestamp: new Date().toISOString(),
        },
    };
    if (status === 'success') {
        base.data = dataOrError;
        // Record metrics
        const extra = {};
        if (base.data && base.data.metadata?.usage) {
            extra.usage = base.data.metadata.usage;
        }
        metrics_js_1.metrics.record(skillName, durationMs, 'success', extra);
    }
    else {
        const err = dataOrError;
        base.error = {
            code: err.code || 'EXECUTION_ERROR',
            message: err.message || String(err),
        };
        metrics_js_1.metrics.record(skillName, durationMs, 'error');
    }
    return base;
}
function wrapSkill(skillName, fn) {
    const startTime = Date.now();
    try {
        return buildOutput(skillName, 'success', fn(), startTime);
    }
    catch (err) {
        return buildOutput(skillName, 'error', err, startTime);
    }
}
async function wrapSkillAsync(skillName, fn) {
    const startTime = Date.now();
    try {
        return buildOutput(skillName, 'success', await fn(), startTime);
    }
    catch (err) {
        return buildOutput(skillName, 'error', err, startTime);
    }
}
function runSkill(skillName, fn) {
    const output = wrapSkill(skillName, fn);
    console.log(JSON.stringify(output, null, 2));
    if (output.status === 'error')
        process.exit(1);
    return output;
}
async function runSkillAsync(skillName, fn) {
    const output = await wrapSkillAsync(skillName, fn);
    console.log(JSON.stringify(output, null, 2));
    if (output.status === 'error')
        process.exit(1);
    return output;
}
// Aliases for backward compatibility
exports.runAsyncSkill = runSkillAsync;
//# sourceMappingURL=skill-wrapper.js.map