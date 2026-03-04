"use strict";
/**
 * Reflex Terminal (RT) - Core Logic v1.1 (Native Bridge Edition)
 * Provides a persistent virtual terminal session using native child_process.
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
exports.ReflexTerminal = void 0;
const node_child_process_1 = require("node:child_process");
const os = __importStar(require("node:os"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const core_js_1 = require("./core.js");
class ReflexTerminal {
    proc;
    feedbackPath;
    constructor(options = {}) {
        const shell = options.shell || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh');
        this.feedbackPath = options.feedbackPath || path.join(process.cwd(), 'active/shared/last_response.json');
        this.proc = (0, node_child_process_1.spawn)(shell, ['-i'], {
            cwd: path.resolve(options.cwd || process.cwd()),
            env: { ...process.env, TERM: 'xterm-256color', PAGER: 'cat' },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        this.setupListeners(options.onOutput);
        core_js_1.logger.info(`[RT] Reflex Terminal (Native) started with shell: ${shell}`);
    }
    setupListeners(onOutput) {
        this.proc.stdout?.on('data', (data) => {
            const str = data.toString();
            if (onOutput)
                onOutput(str);
            process.stdout.write(str);
        });
        this.proc.stderr?.on('data', (data) => {
            const str = data.toString();
            if (onOutput)
                onOutput(str);
            process.stderr.write(str);
        });
        this.proc.on('exit', (code) => {
            core_js_1.logger.warn(`[RT] Shell exited with code ${code}`);
        });
    }
    /**
     * Inject a command into the terminal.
     */
    execute(command) {
        core_js_1.logger.info(`[RT] Injecting command: ${command}`);
        this.proc.stdin?.write(`${command}\n`);
    }
    /**
     * Manually trigger a feedback update to the shared response file.
     */
    persistResponse(text, skillName = 'reflex-terminal') {
        try {
            const cleanText = core_js_1.ui.stripAnsi(text).trim();
            if (!cleanText)
                return;
            const envelope = {
                skill: skillName,
                status: 'success',
                data: { message: cleanText },
                metadata: {
                    timestamp: new Date().toISOString(),
                    duration_ms: 0
                }
            };
            const dir = path.dirname(this.feedbackPath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.feedbackPath, JSON.stringify(envelope, null, 2), 'utf8');
            core_js_1.logger.success(`[RT] Response persisted to ${this.feedbackPath}`);
        }
        catch (err) {
            core_js_1.logger.error(`[RT] Failed to persist response: ${err.message}`);
        }
    }
    kill() {
        this.proc.kill();
    }
}
exports.ReflexTerminal = ReflexTerminal;
//# sourceMappingURL=reflex-terminal.js.map