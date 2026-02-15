#!/usr/bin/env node
const { execSync } = require('child_process');
const chalk = require('chalk');

/**
 * iTerm2 Scheduler Utility
 * Usage: node scripts/iterm_scheduler.cjs "Your Prompt"
 */
async function scheduleTask() {
  const prompt = process.argv[2];
  if (!prompt) {
    console.log(chalk.red('Please provide a prompt to send to iTerm2.'));
    return;
  }

  console.log(chalk.cyan(`\u23f3 Searching all iTerm2 tabs for Gemini CLI session...`));

  while (true) {
    try {
      const findSessionScript = `
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if contents of s contains "> Type your message" then
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

      const result = execSync(`osascript -e '${findSessionScript.replace(/'/g, "'\\''")}'`, { encoding: 'utf8' }).trim();

      if (result !== "NOT_FOUND") {
        const [winId, sessionId] = result.split(':');
        console.log(chalk.green(`\ud83d\ude80 Found Gemini in Win:${winId}, Session:${sessionId}. Sending prompt...`));
        
        const sendScript = `
          tell application "iTerm2"
            tell (first window whose id is ${winId})
              tell (first session whose id is "${sessionId}")
                write text "${prompt}"
              end tell
            end tell
          end tell
          tell application "System Events" to key code 36
        `;
        execSync(`osascript -e '${sendScript.replace(/'/g, "'\\''")}'`);
        break;
      }
    } catch (e) {
      console.log(chalk.red(`Error: ${e.message}`));
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

scheduleTask();
