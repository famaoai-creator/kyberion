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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.consultVision = consultVision;
const core_js_1 = require("./core.js");
const metrics_js_1 = require("./metrics.js");
const readline = __importStar(require("node:readline"));
const chalk_1 = __importDefault(require("chalk"));
async function consultVision(context, options) {
    core_js_1.logger.warn(`🚨 [VISION_JUDGE] Logical Deadlock Detected in: ${context}`);
    console.log(chalk_1.default.cyan('\n--- Vision Tie-break Required ---'));
    console.log(chalk_1.default.white(`Context: ${context}`));
    console.log(chalk_1.default.gray('The following options are logically similar. Please decide based on your Vision:'));
    options.forEach((opt, idx) => {
        console.log(`${idx + 1}. [${opt.id}] ${opt.description} (Logic: ${opt.logic_score})`);
        if (opt.vision_alignment_hint) {
            console.log(chalk_1.default.italic.yellow(`   💡 AI Thought: ${opt.vision_alignment_hint}`));
        }
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        const ask = () => {
            rl.question(chalk_1.default.bold('\nSelect option (number) or type choice ID: '), (answer) => {
                const choiceIdx = parseInt(answer) - 1;
                const selected = options[choiceIdx] || options.find(o => o.id === answer);
                if (selected) {
                    rl.close();
                    metrics_js_1.metrics.recordIntervention(context, selected.id);
                    core_js_1.logger.success(`✅ Vision set to: ${selected.id}`);
                    resolve(selected);
                }
                else {
                    console.log(chalk_1.default.red('Invalid selection. Try again.'));
                    ask();
                }
            });
        };
        ask();
    });
}
