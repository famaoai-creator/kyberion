import { safeWriteFile } from '@agent/core';
import * as path from 'node:path';

/**
 * Utility to manually trigger the Slack feedback loop from within the AI conversation.
 * Usage: node dist/scripts/slack_echo.js "Your message here"
 */
async function main() {
  const message = process.argv.slice(2).join(' ');
  if (!message) return;

  const output = {
    skill: 'interactive-chat',
    status: 'success',
    data: { message },
    metadata: {
      timestamp: new Date().toISOString(),
      duration_ms: 0
    }
  };

  const responsePath = path.join(process.cwd(), 'active/shared/last_response.json');
  safeWriteFile(responsePath, JSON.stringify(output, null, 2));
  console.log(`[SlackEcho] Message mirrored to ${responsePath}`);
}

main().catch(console.error);
