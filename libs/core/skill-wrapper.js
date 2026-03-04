"use strict";
/**
 * TypeScript version of skill-wrapper.
 * Provides typed wrappers for skill execution with standardized output.
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
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
function printOutput(output) {
    const isHuman = process.env.GEMINI_FORMAT === 'human' || process.argv.includes('--format=human');
    // Persistence for Feedback Loop: Save the latest response to a physical file
    try {
        const sharedDir = path.join(process.cwd(), 'active/shared');
        if (!fs.existsSync(sharedDir))
            fs.mkdirSync(sharedDir, { recursive: true });
        fs.writeFileSync(path.join(sharedDir, 'last_response.json'), JSON.stringify(output, null, 2), 'utf8');
    }
    catch (_) { /* Ignore silent failures in persistence */ }
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