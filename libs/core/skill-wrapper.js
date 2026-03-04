"use strict";
/**
 * TypeScript version of skill-wrapper.
 * Provides typed wrappers for skill execution with standardized output.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAsyncSkill = void 0;
exports.wrapSkill = wrapSkill;
exports.wrapSkillAsync = wrapSkillAsync;
exports.runSkill = runSkill;
exports.runSkillAsync = runSkillAsync;
const metrics_js_1 = require("./metrics.js");
const chalk = require('chalk').default || require('chalk');
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
function printOutput(output) {
    const isHuman = process.env.GEMINI_FORMAT === 'human' || process.argv.includes('--format=human');
    if (isHuman) {
        if (output.status === 'success') {
            console.log(chalk.green(`\n✅ ${output.skill} success`));
            if (output.data) {
                if (typeof output.data === 'string') {
                    console.log(output.data);
                }
                else if (output.data.message) {
                    console.log(output.data.message);
                }
                else {
                    console.log(JSON.stringify(output.data, null, 2));
                }
            }
        }
        else {
            console.log(chalk.red(`\n❌ ${output.skill} error`));
            console.log(chalk.yellow(`Code: ${output.error?.code}`));
            console.log(output.error?.message);
        }
        console.log(chalk.dim(`Duration: ${output.metadata.duration_ms}ms | ${output.metadata.timestamp}\n`));
    }
    else {
        console.log(JSON.stringify(output, null, 2));
    }
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
    printOutput(output);
    if (output.status === 'error')
        process.exit(1);
    return output;
}
async function runSkillAsync(skillName, fn) {
    const output = await wrapSkillAsync(skillName, fn);
    printOutput(output);
    if (output.status === 'error')
        process.exit(1);
    return output;
}
exports.runAsyncSkill = runSkillAsync;
//# sourceMappingURL=skill-wrapper.js.map