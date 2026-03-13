"use strict";
/**
 * libs/core/skill-wrapper.ts
 * Provides typed wrappers for capability execution with standardized output.
 * [SECURE-IO COMPLIANT VERSION]
 */
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAsyncSkill = void 0;
exports.wrapSkill = wrapSkill;
exports.wrapSkillAsync = wrapSkillAsync;
exports.runSkill = runSkill;
exports.runSkillAsync = runSkillAsync;
exports.runSkillCli = runSkillCli;
exports.runSkillAsyncCli = runSkillAsyncCli;
const metrics_js_1 = require("./metrics.js");
const core_js_1 = require("./core.js");
const secure_io_js_1 = require("./secure-io.js");
const path_resolver_js_1 = require("./path-resolver.js");
const chalk_1 = __importDefault(require("chalk"));
const path = __importStar(require("node:path"));
function buildOutput(skillName, status, dataOrError, startTime) {
    const durationMs = Date.now() - startTime;
    const base = {
        skill: skillName,
        status,
        metadata: {
            duration_ms: durationMs,
            timestamp: new Date().toISOString(),
            system_directive: core_js_1.fileUtils.getGoldenRule(),
        },
    };
    if (status === 'success') {
        base.data = dataOrError;
        const extra = {};
        if (base.data) {
            const data = base.data;
            if (data.metadata?.usage)
                extra.usage = data.metadata.usage;
            if (data.metadata?.model)
                extra.model = data.metadata.model;
            if (data.intervention)
                extra.intervention = true;
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
    const isHuman = process.env.KYBERION_FORMAT === 'human' || process.argv.includes('--format=human');
    // Persistence for Feedback Loop: Save the latest response via Secure IO
    try {
        const sharedPath = path.join(path_resolver_js_1.pathResolver.rootDir(), 'active/shared/last_response.json');
        (0, secure_io_js_1.safeWriteFile)(sharedPath, JSON.stringify(output, null, 2));
    }
    catch (_) {
        /* Silent fail for background persistence */
    }
    if (isHuman) {
        if (output.status === 'success') {
            console.log(chalk_1.default.green(`\n✅ ${output.skill} success`));
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
            console.log(chalk_1.default.red(`\n❌ ${output.skill} error`));
            console.log(chalk_1.default.yellow(`Code: ${output.error?.code}`));
            console.log(output.error?.message);
        }
        if (output.metadata) {
            console.log(chalk_1.default.dim(`Duration: ${output.metadata.duration_ms}ms | ${output.metadata.timestamp}\n`));
        }
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
    return output;
}
async function runSkillAsync(skillName, fn) {
    const output = await wrapSkillAsync(skillName, fn);
    printOutput(output);
    return output;
}
function runSkillCli(skillName, fn) {
    const output = runSkill(skillName, fn);
    if (output.status === 'error')
        process.exit(1);
}
async function runSkillAsyncCli(skillName, fn) {
    const output = await runSkillAsync(skillName, fn);
    if (output.status === 'error')
        process.exit(1);
}
exports.runAsyncSkill = runSkillAsync;
