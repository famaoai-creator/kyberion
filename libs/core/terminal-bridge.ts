import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';

/**
 * Terminal Bridge v4.0 (Isolated Session Protocol)
 * Uses file-based I/O at active/shared/runtime/terminal/{sessionId}/
 */

const RUNTIME_BASE = path.join(process.cwd(), 'active/shared/runtime/terminal');

const STRATEGIES: Record<string, any> = {
  ReflexTerminal: {
    findIdle: () => {
      if (!safeExistsSync(RUNTIME_BASE)) return null;
      
      const sessions = safeReaddir(RUNTIME_BASE);
      for (const id of sessions) {
        const stateFile = path.join(RUNTIME_BASE, id, 'state.json');
        if (safeExistsSync(stateFile)) {
          try {
            const state = JSON.parse(safeReadFile(stateFile, { encoding: 'utf8' }) as string);
            // Simple check if the process is still alive
            process.kill(state.pid, 0);
            return { winId: 'rt-main', sessionId: id, type: 'ReflexTerminal' };
          } catch (_) {
            // Process dead, cleanup state if needed?
          }
        }
      }
      return null;
    },
    inject: async (winId: string, sessionId: string, text: string) => {
      const sid = sessionId || 'default';
      const sessionInDir = path.join(RUNTIME_BASE, sid, 'in');
      
      try {
        if (!safeExistsSync(sessionInDir)) {
          safeMkdir(sessionInDir, { recursive: true });
        }
        
        const requestId = `req-${Date.now()}`;
        const requestPath = path.join(sessionInDir, `${requestId}.json`);
        
        safeWriteFile(requestPath, JSON.stringify({
          id: requestId,
          ts: new Date().toISOString(),
          text
        }, null, 2));
        
        return true;
      } catch (err: any) {
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
        const result = execSync("osascript -e '" + script.replace(/'/g, "'\\''") + "'", { encoding: 'utf8' }).trim();
        if (result === 'NOT_FOUND' || !result.includes(':')) return null;
        const [winId, sessionId] = result.split(':');
        return { winId, sessionId, type: 'iTerm2' };
      } catch (_) { return null; }
    },
    inject: async (winId: string, sessionId: string, text: string) => {
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
        const result = execSync("osascript -e '" + script.replace(/'/g, "'\\''") + "'", { encoding: 'utf8' }).trim();
        return result === 'SUCCESS';
      } catch (_) { return false; }
    }
  }
};

export const terminalBridge = {
  findIdleSession: () => {
    const rt = STRATEGIES.ReflexTerminal.findIdle();
    if (rt) return rt;
    const iterm = STRATEGIES.iTerm2.findIdle();
    if (iterm) return iterm;
    return null;
  },
  injectAndExecute: async (winId: string, sessionId: string, text: string, terminalType = 'iTerm2') => {
    const strategy = STRATEGIES[terminalType];
    if (!strategy) throw new Error(`Unsupported terminal strategy: ${terminalType}`);
    return await strategy.inject(winId, sessionId, text);
  },
  readLatestOutput: (winId: string, sessionId: string, terminalType = 'iTerm2'): string => {
    if (terminalType === 'ReflexTerminal') {
      const latestPath = path.join(RUNTIME_BASE, sessionId, 'out', 'latest_response.json');
      if (safeExistsSync(latestPath)) {
        try {
          const content = JSON.parse(safeReadFile(latestPath, { encoding: 'utf8' }) as string);
          return content.data.message || '';
        } catch (_) { return ''; }
      }
      return '';
    }
    // Fallback for iTerm2
    return '';
  }
};
