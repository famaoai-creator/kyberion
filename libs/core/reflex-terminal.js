"use strict";
/**
 * Reflex Terminal (RT) - Core Logic v2.0 (node-pty Edition)
 * Provides a persistent virtual terminal session using node-pty for true PTY support.
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
const pty = __importStar(require("node-pty"));
const os = __importStar(require("node:os"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const core_js_1 = require("./core.js");
class ReflexTerminal {
    ptyProcess;
    feedbackPath;
    constructor(options = {}) {
        const shell = options.shell || (os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
        this.feedbackPath = options.feedbackPath || path.join(process.cwd(), 'active/shared/last_response.json');
        this.ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: options.cols || 80,
            rows: options.rows || 24,
            cwd: path.resolve(options.cwd || process.cwd()),
            env: { ...process.env, TERM: 'xterm-256color', PAGER: 'cat' }
        });
        this.setupListeners(options.onOutput);
        core_js_1.logger.info(`[RT] Reflex Terminal (node-pty) started with shell: ${shell}`);
    }
    setupListeners(onOutput) {
        this.ptyProcess.onData((data) => {
            if (onOutput)
                onOutput(data);
            // Optional: fallback to stdout if needed, but usually redundant for PTY
            // process.stdout.write(data); 
        });
        this.ptyProcess.onExit(({ exitCode, signal }) => {
            core_js_1.logger.warn(`[RT] PTY process exited with code ${exitCode}, signal ${signal}`);
        });
    }
    /**
     * Inject a command or raw input into the terminal.
     */
    execute(command) {
        core_js_1.logger.info(`[RT] Injecting command: ${command}`);
        this.ptyProcess.write(`${command}\r`);
    }
    /**
     * Write raw data to the terminal.
     */
    write(data) {
        this.ptyProcess.write(data);
    }
    /**
     * Resize the terminal dimensions.
     */
    resize(cols, rows) {
        this.ptyProcess.resize(cols, rows);
    }
    /**
     * Register an output listener.
     */
    onData(callback) {
        return this.ptyProcess.onData(callback);
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
        this.ptyProcess.kill();
    }
}
exports.ReflexTerminal = ReflexTerminal;
//# sourceMappingURL=reflex-terminal.js.map