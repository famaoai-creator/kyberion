"use strict";
/**
 * Reflex Terminal (RT) - Self-Healing Edition v3.0
 * Provides terminal session with automatic fallback between node-pty and child_process.
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
/**
 * Adapter using node-pty (Native PTY)
 */
class PtyAdapter {
    pty;
    constructor(pty) {
        this.pty = pty;
    }
    write(data) { this.pty.write(data); }
    resize(cols, rows) { this.pty.resize(cols, rows); }
    kill() { this.pty.kill(); }
    onData(cb) { this.pty.onData(cb); }
    onExit(cb) { this.pty.onExit(cb); }
    getPid() { return this.pty.pid; }
}
/**
 * Fallback Adapter using standard child_process (Basic Emulation)
 */
class ChildProcessAdapter {
    process;
    constructor(shell, args, options) {
        this.process = (0, node_child_process_1.spawn)(shell, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        core_js_1.logger.warn('[RT] node-pty failed. Falling back to ChildProcess emulation.');
    }
    write(data) { this.process.stdin?.write(data); }
    resize() { }
    kill() { this.process.kill(); }
    onData(cb) {
        this.process.stdout?.on('data', (d) => cb(d.toString()));
        this.process.stderr?.on('data', (d) => cb(d.toString()));
    }
    onExit(cb) {
        this.process.on('exit', cb);
    }
    getPid() { return this.process.pid; }
}
class ReflexTerminal {
    adapter;
    feedbackPath;
    constructor(options = {}) {
        const shell = options.shell || (os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
        const cwd = path.resolve(options.cwd || process.cwd());
        this.feedbackPath = options.feedbackPath || path.join(process.cwd(), 'active/shared/last_response.json');
        const env = { ...process.env, TERM: 'xterm-256color', PAGER: 'cat' };
        try {
            // Dynamic import to avoid crash if node-pty is missing or broken
            const pty = require('node-pty');
            const ptyInstance = pty.spawn(shell, [], {
                name: 'xterm-256color',
                cols: options.cols || 80,
                rows: options.rows || 24,
                cwd,
                env
            });
            this.adapter = new PtyAdapter(ptyInstance);
            core_js_1.logger.info(`[RT] Using Native PTY (node-pty)`);
        }
        catch (err) {
            // Fallback to child_process
            this.adapter = new ChildProcessAdapter(shell, [], { cwd, env });
            core_js_1.logger.info(`[RT] Using Emulated Terminal (child_process)`);
        }
        this.setupListeners(options.onOutput);
    }
    setupListeners(onOutput) {
        const DSR_REQ = /\x1b\[\??6n/g;
        const DSR_RES = '\x1b[1;1R';
        this.adapter.onData((data) => {
            let processedData = data;
            // 1. Detect and auto-respond to DSR (Device Status Report)
            // This prevents interactive tools (less, git, etc.) from hanging.
            if (DSR_REQ.test(data)) {
                this.adapter.write(DSR_RES);
                // Strip the request from the output to keep logs/AI context clean
                processedData = data.replace(DSR_REQ, '');
            }
            if (onOutput && processedData.length > 0) {
                onOutput(processedData);
            }
        });
        this.adapter.onExit((code, signal) => {
            core_js_1.logger.warn(`[RT] Terminal process exited with code ${code}, signal ${signal}`);
        });
    }
    execute(command) {
        core_js_1.logger.info(`[RT] Injecting command: ${command}`);
        this.adapter.write(`${command}\n`); // Changed \r to \n for better compatibility with child_process
    }
    write(data) {
        this.adapter.write(data);
    }
    resize(cols, rows, width, height) {
        this.adapter.resize(cols, rows, width, height);
    }
    getPid() {
        return this.adapter.getPid();
    }
    kill() {
        this.adapter.kill();
    }
    persistResponse(text, skillName = 'reflex-terminal') {
        try {
            const cleanText = core_js_1.ui.stripAnsi(text).trim();
            if (!cleanText)
                return;
            const envelope = {
                skill: skillName,
                status: 'success',
                data: { message: cleanText },
                metadata: { timestamp: new Date().toISOString(), duration_ms: 0 }
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
}
exports.ReflexTerminal = ReflexTerminal;
