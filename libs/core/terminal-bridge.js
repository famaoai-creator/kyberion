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
exports.terminalBridge = void 0;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Terminal Bridge v4.0 (Isolated Session Protocol)
 * Uses file-based I/O at active/shared/runtime/terminal/{sessionId}/
 */
const RUNTIME_BASE = path.join(process.cwd(), 'active/shared/runtime/terminal');
const STRATEGIES = {
    ReflexTerminal: {
        findIdle: () => {
            if (!fs.existsSync(RUNTIME_BASE))
                return null;
            const sessions = fs.readdirSync(RUNTIME_BASE);
            for (const id of sessions) {
                const stateFile = path.join(RUNTIME_BASE, id, 'state.json');
                if (fs.existsSync(stateFile)) {
                    try {
                        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                        // Simple check if the process is still alive
                        process.kill(state.pid, 0);
                        return { winId: 'rt-main', sessionId: id, type: 'ReflexTerminal' };
                    }
                    catch (_) {
                        // Process dead, cleanup state if needed?
                    }
                }
            }
            return null;
        },
        inject: async (winId, sessionId, text) => {
            const sid = sessionId || 'default';
            const sessionInDir = path.join(RUNTIME_BASE, sid, 'in');
            try {
                if (!fs.existsSync(sessionInDir)) {
                    fs.mkdirSync(sessionInDir, { recursive: true });
                }
                const requestId = `req-${Date.now()}`;
                const requestPath = path.join(sessionInDir, `${requestId}.json`);
                fs.writeFileSync(requestPath, JSON.stringify({
                    id: requestId,
                    ts: new Date().toISOString(),
                    text
                }, null, 2), 'utf8');
                return true;
            }
            catch (err) {
                console.error(`[TerminalBridge] File Injection Failed for ${sid}: ${err.message}`);
                return false;
            }
        }
    },
    iTerm2: {
        findIdle: () => {
            const script = `
        tell application "iTerm2"
          if not (exists windows) then return "NOT_FOUND"
          set bestSession to "NOT_FOUND"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                try
                  set conts to contents of s
                  if conts contains "Gemini" then
                    set bestSession to (id of w as string) & ":" & (unique ID of s as string)
                    exit repeat
                  end if
                end try
              end repeat
              if bestSession is not "NOT_FOUND" then exit repeat
            end repeat
            if bestSession is not "NOT_FOUND" then exit repeat
          end repeat
          if bestSession is "NOT_FOUND" then
            try
              set w to front window
              set t to current tab of w
              set s to current session of t
              set bestSession to (id of w as string) & ":" & (unique ID of s as string)
            on error
              return "NOT_FOUND"
            end try
          end if
          return bestSession
        end tell
      `;
            try {
                const result = (0, node_child_process_1.execSync)("osascript -e '" + script.replace(/'/g, "'\\''") + "'", { encoding: 'utf8' }).trim();
                if (result === 'NOT_FOUND' || !result.includes(':'))
                    return null;
                const [winId, sessionId] = result.split(':');
                return { winId, sessionId, type: 'iTerm2' };
            }
            catch (_) {
                return null;
            }
        },
        inject: async (winId, sessionId, text) => {
            const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
            const script = `
        tell application "iTerm2"
          try
            repeat with w in windows
              repeat with t in tabs of w
                repeat with s in sessions of t
                  if (unique ID of s as string) is "${sessionId}" then
                    tell s
                      write text "${escapedText}"
                    end tell
                    tell application "System Events" to key code 36
                    return "SUCCESS"
                  end if
                end repeat
              end repeat
            end repeat
          on error errText
            return "ERROR: " & errText
          end try
          return "SESSION_NOT_FOUND"
        end tell
      `;
            try {
                const result = (0, node_child_process_1.execSync)("osascript -e '" + script.replace(/'/g, "'\\''") + "'", { encoding: 'utf8' }).trim();
                return result === 'SUCCESS';
            }
            catch (_) {
                return false;
            }
        }
    }
};
exports.terminalBridge = {
    findIdleSession: () => {
        const rt = STRATEGIES.ReflexTerminal.findIdle();
        if (rt)
            return rt;
        const iterm = STRATEGIES.iTerm2.findIdle();
        if (iterm)
            return iterm;
        return null;
    },
    injectAndExecute: async (winId, sessionId, text, terminalType = 'iTerm2') => {
        const strategy = STRATEGIES[terminalType];
        if (!strategy)
            throw new Error(`Unsupported terminal strategy: ${terminalType}`);
        return await strategy.inject(winId, sessionId, text);
    },
    readLatestOutput: (winId, sessionId, terminalType = 'iTerm2') => {
        if (terminalType === 'ReflexTerminal') {
            const latestPath = path.join(RUNTIME_BASE, sessionId, 'out', 'latest_response.json');
            if (fs.existsSync(latestPath)) {
                try {
                    const content = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
                    return content.data.message || '';
                }
                catch (_) {
                    return '';
                }
            }
            return '';
        }
        // Fallback for iTerm2
        return '';
    }
};
