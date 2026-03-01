/**
 * Terminal Bridge v2.2 (Clipboard Paste Edition)
 * Encapsulates AppleScript-based terminal automation.
 * Uses system clipboard for 100% reliable multiline injection.
 */

const { execSync } = require('child_process');

const terminalBridge = {
  /**
   * Find an active, idle session across supported terminal types.
   */
  findIdleSession: () => {
    const script = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if (contents of s contains "> Type your message") or (contents of s contains "Gemini CLI") then
                if is processing of s is false then
                  return "iTerm2:" & (id of w as string) & ":" & (id of s as string)
                end if
              end if
            end repeat
          end repeat
        end repeat
      end tell
      tell application "System Events"
        if (count (processes whose name is "Code")) > 0 then
          return "VSCode:0:0"
        end if
      end tell
      return "NOT_FOUND"
    `;

    try {
      const result = execSync(`osascript -e '${script.replace(/'/g, "'''")}'`, { encoding: 'utf8' }).trim();
      if (result === 'NOT_FOUND') return null;
      const [type, winId, sessionId] = result.split(':');
      return { type, winId, sessionId };
    } catch (_) { return null; }
  },

  /**
   * Inject text using Clipboard + Paste strategy for maximum reliability.
   */
  injectAndExecute: (winId, sessionId, text, terminalType = 'iTerm2') => {
    try {
      // 1. Copy text to clipboard using pbcopy
      const pbcopy = require('child_process').spawn('pbcopy');
      pbcopy.stdin.write(text);
      pbcopy.stdin.end();

      // 2. Perform Paste via AppleScript
      let script = '';
      if (terminalType === 'iTerm2') {
        script = `
          tell application "iTerm2"
            tell (window id ${winId})
              tell (session id "${sessionId}")
                select
                tell application "System Events" to keystroke "v" using {command down}
              end tell
            end tell
          end tell
        `;
      } else if (terminalType === 'VSCode') {
        script = `
          tell application "Code" to activate
          delay 0.1
          tell application "System Events" to keystroke "v" using {command down}
        `;
      }

      if (script) {
        execSync(`osascript -e '${script.replace(/'/g, "'''")}'`);
        // 3. Finalize with Enter
        execSync(`osascript -e 'tell application "System Events" to key code 36'`);
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[TerminalBridge] Clipboard Injection Failure (${terminalType}): ${err.message}`);
      return false;
    }
  }
};

module.exports = terminalBridge;
