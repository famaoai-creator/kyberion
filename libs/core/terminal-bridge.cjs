/**
 * Terminal Bridge v2.0 (Multi-Terminal Edition)
 * Encapsulates AppleScript-based terminal automation.
 * Supports iTerm2, VS Code, and others with an extensible strategy model.
 */

const { execSync } = require('child_process');

const STRATEGIES = {
  iTerm2: {
    findIdle: () => {
      const script = `
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if (contents of s contains "> Type your message") or (contents of s contains "Gemini CLI") then
                  if is processing of s is false then
                    return (id of w as string) & ":" & (id of s as string)
                  end if
                end if
              end repeat
            end repeat
          end repeat
          return "NOT_FOUND"
        end tell
      `;
      try {
        const result = execSync(`osascript -e '${script.replace(/'/g, "'''")}'`, { encoding: 'utf8' }).trim();
        if (result === 'NOT_FOUND') return null;
        const [winId, sessionId] = result.split(':');
        return { winId, sessionId, type: 'iTerm2' };
      } catch (_) { return null; }
    },
    inject: (winId, sessionId, text) => {
      const script = `
        tell application "iTerm2"
          repeat with w in windows
            if id of w is ${winId} then
              repeat with t in tabs of w
                repeat with s in sessions of t
                  if id of s is "${sessionId}" then
                    tell s
                      write text "${text.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
                    end tell
                  end if
                end repeat
              end repeat
            end if
          end repeat
        end tell
        tell application "System Events" to key code 36
      `;
      execSync(`osascript -e '${script.replace(/'/g, "'''")}'`);
      return true;
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
        const result = execSync(`osascript -e '${script.replace(/'/g, "'''")}'`, { encoding: 'utf8' }).trim();
        return result === 'CODE_RUNNING' ? { type: 'VSCode' } : null;
      } catch (_) { return null; }
    },
    inject: (winId, sessionId, text) => {
      const script = `
        tell application "Code" to activate
        tell application "System Events"
          keystroke "${text.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
          key code 36
        end tell
      `;
      execSync(`osascript -e '${script.replace(/'/g, "'''")}'`);
      return true;
    }
  }
};

const terminalBridge = {
  /**
   * Find an active, idle session across supported terminal types.
   */
  findIdleSession: () => {
    const iterm = STRATEGIES.iTerm2.findIdle();
    if (iterm) return iterm;

    const vscode = STRATEGIES.VSCode.findIdle();
    if (vscode) return vscode;

    return null;
  },

  /**
   * Inject text and press Enter in a specific session.
   */
  injectAndExecute: (winId, sessionId, text, terminalType = 'iTerm2') => {
    const strategy = STRATEGIES[terminalType];
    if (!strategy) {
      throw new Error(`Unsupported terminal strategy: ${terminalType}`);
    }
    try {
      return strategy.inject(winId, sessionId, text);
    } catch (err) {
      console.error(`[TerminalBridge] Injection Failure (${terminalType}): ${err.message}`);
      return false;
    }
  }
};

module.exports = terminalBridge;
