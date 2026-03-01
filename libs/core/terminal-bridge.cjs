/**
 * Terminal Bridge v2.8 (Resilient Discovery Edition)
 * Encapsulates AppleScript-based terminal automation.
 * Uses highly resilient session discovery logic.
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
                set conts to contents of s
                -- More resilient detection: prompt or just the presence of Gemini
                if (conts contains "> ") or (conts contains "Gemini") then
                  return (id of w as string) & ":" & (unique ID of s as string)
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
        const result = execSync(`osascript -e '${script.replace(/'/g, "'''")}'`, { encoding: 'utf8' }).trim();
        return result === 'SUCCESS';
      } catch (err) {
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
        const result = execSync(`osascript -e '${script.replace(/'/g, "'''")}'`, { encoding: 'utf8' }).trim();
        return result === 'CODE_RUNNING' ? { type: 'VSCode' } : null;
      } catch (_) { return null; }
    },
    inject: (winId, sessionId, text) => {
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
        execSync(`osascript -e '${script.replace(/'/g, "'''")}'`);
        return true;
      } catch (err) {
        console.error(`[TerminalBridge] VSCode Injection Error: ${err.message}`);
        return false;
      }
    }
  }
};

const terminalBridge = {
  findIdleSession: () => {
    const iterm = STRATEGIES.iTerm2.findIdle();
    if (iterm) return iterm;
    const vscode = STRATEGIES.VSCode.findIdle();
    if (vscode) return vscode;
    return null;
  },
  injectAndExecute: (winId, sessionId, text, terminalType = 'iTerm2') => {
    const strategy = STRATEGIES[terminalType];
    if (!strategy) throw new Error(`Unsupported terminal strategy: ${terminalType}`);
    return strategy.inject(winId, sessionId, text);
  }
};

module.exports = terminalBridge;
