import { execSync } from 'node:child_process';

/**
 * Terminal Bridge v2.8 (Resilient Discovery Edition)
 */

const STRATEGIES: Record<string, any> = {
  iTerm2: {
    findIdle: () => {
      const script = `
        tell application "iTerm2"
          set bestSession to "NOT_FOUND"
          set maxOffset to -1
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                set conts to contents of s
                set off to offset of "Gemini" in conts
                if off > maxOffset then
                  set maxOffset to off
                  set bestSession to (id of w as string) & ":" & (unique ID of s as string)
                end if
              end repeat
            end repeat
          end repeat
          
          -- Fallback: If no Gemini session, take the front-most session
          if bestSession is "NOT_FOUND" then
            try
              set w to front window
              set t to current tab of w
              set s to current session of t
              set bestSession to (id of w as string) & ":" & (unique ID of s as string)
            end try
          end if
          
          return bestSession
        end tell
      `;
      try {
        const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf8' }).trim();
        if (result === 'NOT_FOUND') return null;
        const [winId, sessionId] = result.split(':');
        return { winId, sessionId, type: 'iTerm2' };
      } catch (_) { return null; }
    },
    inject: (winId: string, sessionId: string, text: string) => {
      const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      const script = `
        tell application "iTerm2"
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
          return "SESSION_NOT_FOUND"
        end tell
      `;
      try {
        const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf8' }).trim();
        return result === 'SUCCESS';
      } catch (err: any) {
        console.error(`[TerminalBridge] iTerm2 Injection Error: ${err.message}`);
        return false;
      }
    }
  },
  VSCode: {
    findIdle: () => {
      const script = `
        tell application "System Events"
          if (count (processes whose name is "Code")) > 0 then
            return "CODE_RUNNING"
          end if
          return "NOT_FOUND"
        end tell
      `;
      try {
        const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf8' }).trim();
        return result === 'CODE_RUNNING' ? { type: 'VSCode' } : null;
      } catch (_) { return null; }
    },
    inject: (winId: string, sessionId: string, text: string) => {
      const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `
        tell application "Code" to activate
        delay 0.1
        tell application "System Events"
          keystroke "${escapedText}"
          key code 36
        end tell
      `;
      try {
        execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
        return true;
      } catch (err: any) {
        console.error(`[TerminalBridge] VSCode Injection Error: ${err.message}`);
        return false;
      }
    }
  }
};

export const terminalBridge = {
  findIdleSession: () => {
    const iterm = STRATEGIES.iTerm2.findIdle();
    if (iterm) return iterm;
    const vscode = STRATEGIES.VSCode.findIdle();
    if (vscode) return vscode;
    return null;
  },
  injectAndExecute: (winId: string, sessionId: string, text: string, terminalType = 'iTerm2') => {
    const strategy = STRATEGIES[terminalType];
    if (!strategy) throw new Error(`Unsupported terminal strategy: ${terminalType}`);
    return strategy.inject(winId, sessionId, text);
  },
  readLatestOutput: (winId: string, sessionId: string, terminalType = 'iTerm2'): string => {
    if (terminalType !== 'iTerm2') return '';
    const script = `
      tell application "iTerm2"
        try
          set w to window id ${winId}
          set s to session id "${sessionId}" of w
          return contents of s
        on error
          return "ERROR"
        end try
      end tell
    `;
    try {
      return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }
};
