/**
 * Terminal Bridge v1.0
 * Encapsulates AppleScript-based terminal automation.
 * Supports iTerm2 (default) with extensibility for other platforms.
 */

const { execSync } = require('child_process');

const terminalBridge = {
  /**
   * Find an active, idle session of Gemini CLI.
   * @returns {Object|null} { winId, sessionId } or null if not found.
   */
  findIdleSession: (terminalType = 'iTerm2') => {
    if (terminalType !== 'iTerm2') {
      throw new Error(`Unsupported terminal type: ${terminalType}`);
    }

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
      const result = execSync(`osascript -e '${script.replace(/'/g, "'''")}'`, {
        encoding: 'utf8',
      }).trim();

      if (result === 'NOT_FOUND') return null;
      const [winId, sessionId] = result.split(':');
      return { winId, sessionId };
    } catch (err) {
      console.error(`[TerminalBridge] Error finding session: ${err.message}`);
      return null;
    }
  },

  /**
   * Inject text and press Enter in a specific session.
   */
  injectAndExecute: (winId, sessionId, text, terminalType = 'iTerm2') => {
    const script = `
      tell application "iTerm2"
        repeat with w in windows
          if id of w is ${winId} then
            repeat with t in tabs of w
              repeat with s in sessions of t
                if id of s is "${sessionId}" then
                  tell s
                    write text "${text.replace(/"/g, '\\"')}"
                  end tell
                end if
              end repeat
            end repeat
          end if
        end repeat
      end tell
      tell application "System Events" to key code 36
    `;

    try {
      execSync(`osascript -e '${script.replace(/'/g, "'''")}'`);
      return true;
    } catch (err) {
      console.error(`[TerminalBridge] Error injecting text: ${err.message}`);
      return false;
    }
  }
};

module.exports = terminalBridge;
