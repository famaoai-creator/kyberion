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
exports.resolveSkillScript = resolveSkillScript;
exports.runStep = runStep;
exports.runPipeline = runPipeline;
exports.runParallel = runParallel;
exports.loadPipeline = loadPipeline;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const yaml = __importStar(require("js-yaml"));
const core_js_1 = require("./core.js");
const metrics_js_1 = require("./metrics.js");
/**
 * Skill Pipeline Orchestrator - chains skills together with data passing.
 */
const rootDir = process.cwd();
const skillIndex = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
function resolveSkillScript(skillName) {
    const index = JSON.parse(fs.readFileSync(skillIndex, 'utf8'));
    const skills = index.s || index.skills;
    let skill;
    if (skillName.includes('/')) {
        skill = skills.find((s) => (s.path || '').includes(skillName) || (s.n || s.name) === skillName);
    }
    else {
        skill = skills.find((s) => (s.n || s.name) === skillName);
    }
    if (!skill)
        throw new Error(`Skill "${skillName}" not found in index`);
    const skillRelPath = skill.path || skillName;
    const skillDir = path.join(rootDir, skillRelPath);
    const mainPath = skill.m || skill.main;
    if (mainPath) {
        const fullPath = path.join(skillDir, mainPath);
        if (fs.existsSync(fullPath))
            return fullPath;
    }
    const scriptsDir = path.join(skillDir, 'scripts');
    if (!fs.existsSync(scriptsDir))
        throw new Error(`No scripts/ directory for "${skillName}" at ${skillDir}`);
    const scripts = fs.readdirSync(scriptsDir).filter((f) => /\.(cjs|js)$/.test(f));
    if (scripts.length === 0)
        throw new Error(`No .cjs or .js scripts found for "${skillName}"`);
    return path.join(scriptsDir, scripts[0]);
}
function resolveParams(params, prevOutput) {
    const resolved = {};
    for (const [key, val] of Object.entries(params || {})) {
        if (typeof val === 'string' && val.startsWith('$prev.')) {
            const propPath = val.slice(6).split('.');
            let value = prevOutput;
            for (const prop of propPath) {
                value = value?.[prop];
            }
            resolved[key] = value;
        }
        else {
            resolved[key] = val;
        }
    }
    return resolved;
}
function buildArgs(params) {
    const args = [];
    for (const [key, val] of Object.entries(params || {})) {
        if (val === true)
            args.push(`--${key}`);
        else if (val !== false && val !== null && val !== undefined)
            args.push(`--${key}`, `"${String(val)}"`);
    }
    return args.join(' ');
}
function runStep(script, args, step = {}) {
    const maxAttempts = (step.retries || 0) + 1;
    const initialDelay = step.retryDelay || 1000;
    const timeout = step.timeout || 60000;
    const skillDir = path.dirname(path.dirname(script));
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const output = (0, node_child_process_1.execSync)(`node "${script}" ${args}`, {
                encoding: 'utf8',
                cwd: skillDir,
                timeout,
                stdio: 'pipe',
            });
            let parsed;
            try {
                parsed = JSON.parse(output);
            }
            catch {
                parsed = { raw: output.trim() };
            }
            return { status: 'success', data: parsed, attempts: attempt, recovered: attempt > 1 };
        }
        catch (err) {
            let parsedError;
            try {
                parsedError = JSON.parse(err.stdout || err.message);
            }
            catch {
                parsedError = null;
            }
            const isRetryable = parsedError?.error?.retryable || false;
            const shouldRetry = attempt < maxAttempts && (isRetryable || !parsedError);
            if (shouldRetry) {
                const delay = initialDelay * Math.pow(2, attempt - 1);
                core_js_1.logger.warn(`[Orchestrator] Step failed (retryable: ${isRetryable}). Retrying attempt ${attempt + 1}/${maxAttempts} after ${delay}ms...`);
                const delaySec = Math.ceil(delay / 1000);
                (0, node_child_process_1.spawnSync)('sleep', [String(delaySec)], { stdio: 'ignore' });
                continue;
            }
            return {
                status: 'error',
                error: parsedError?.error?.message || err.message,
                attempts: attempt,
                recovered: false,
            };
        }
    }
    return { status: 'error', error: 'Exhausted retries', attempts: maxAttempts, recovered: false };
}
function runPipeline(steps, initialData = {}) {
    const results = [];
    let prevOutput = initialData;
    const startTime = Date.now();
    for (const step of steps) {
        const script = resolveSkillScript(step.skill);
        const params = resolveParams(step.params, prevOutput);
        const args = buildArgs(params);
        const result = runStep(script, args, step);
        results.push({ skill: step.skill, ...result });
        if (result.status === 'success') {
            prevOutput = result.data?.data || result.data;
            metrics_js_1.metrics.record(step.skill, result.data?.metadata?.duration_ms || 0, 'success', {
                recovered: result.recovered,
            });
        }
        else if (!step.continueOnError) {
            break;
        }
    }
    return {
        pipeline: true,
        totalSteps: steps.length,
        completedSteps: results.length,
        duration_ms: Date.now() - startTime,
        steps: results,
    };
}
function runParallel(steps) {
    const startTime = Date.now();
    const promises = steps.map((step) => {
        const script = resolveSkillScript(step.skill);
        const args = buildArgs(step.params);
        const timeout = step.timeout || 60000;
        const skillDir = path.dirname(path.dirname(script));
        return new Promise((resolve) => {
            (0, node_child_process_1.exec)(`node "${script}" ${args}`, {
                encoding: 'utf8',
                cwd: skillDir,
                timeout,
                maxBuffer: 5 * 1024 * 1024,
            }, (err, stdout) => {
                if (err) {
                    resolve({ skill: step.skill, status: 'error', error: err.message, attempts: 1 });
                }
                else {
                    let parsed;
                    try {
                        parsed = JSON.parse(stdout);
                    }
                    catch {
                        parsed = { raw: stdout.trim() };
                    }
                    resolve({ skill: step.skill, status: 'success', data: parsed, attempts: 1 });
                }
            });
        });
    });
    return Promise.all(promises).then((results) => ({
        pipeline: true,
        parallel: true,
        totalSteps: steps.length,
        completedSteps: results.filter((r) => r.status === 'success').length,
        duration_ms: Date.now() - startTime,
        steps: results,
    }));
}
function loadPipeline(yamlPath) {
    const content = fs.readFileSync(path.resolve(yamlPath), 'utf8');
    const def = yaml.load(content);
    if (!def.pipeline || !Array.isArray(def.pipeline)) {
        throw new Error('Invalid pipeline YAML: must have a "pipeline" array');
    }
    return {
        name: def.name || path.basename(yamlPath, '.yml'),
        steps: def.pipeline,
        run: (initialData) => runPipeline(def.pipeline, initialData),
    };
}
//# sourceMappingURL=orchestrator.js.map