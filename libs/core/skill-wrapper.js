"use strict";
/**
 * TypeScript version of skill-wrapper.
 * Provides typed wrappers for skill execution with standardized output.
 *
 * DESIGN NOTE: Library functions (wrapSkill, wrapSkillAsync, runSkill,
 * runSkillAsync) never call process.exit(). That decision belongs to CLI
 * entrypoints. Use runSkillCli() for the traditional "print + exit" behaviour.
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
const chalk_1 = __importDefault(require("chalk"));
function buildOutput(skillName, status, dataOrError, startTime) {
    const durationMs = Date.now() - startTime;
    const base = {
        skill: skillName,
        status,
        metadata: {
            duration_ms: durationMs,
            timestamp: new Date().toISOString(),
            system_directive: core_js_1.fileUtils.getGoldenRule(), // Permanent Decision Logic Injection
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
    catch (_) {
        /* Ignore silent failures in persistence */
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
        console.log(chalk_1.default.dim(`Duration: ${output.metadata.duration_ms}ms | ${output.metadata.timestamp}\n`));
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
/**
 * Run a skill and print its output. Returns the output regardless of status.
 * Does NOT call process.exit — use runSkillCli for CLI entrypoints.
 */
function runSkill(skillName, fn) {
    const output = wrapSkill(skillName, fn);
    printOutput(output);
    return output;
}
/**
 * Async variant of runSkill.
 */
async function runSkillAsync(skillName, fn) {
    const output = await wrapSkillAsync(skillName, fn);
    printOutput(output);
    return output;
}
/**
 * CLI entrypoint wrapper: runs the skill, prints output, and exits with
 * code 1 on error. Use this only in top-level CLI scripts, never in library
 * code that may be imported by tests or other skills.
 */
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
//# sourceMappingURL=skill-wrapper.js.map