import * as fs from 'node:fs';
import * as path from 'node:path';
import { secureFetch } from '../libs/core/network.js';
import { entropyGate } from '../libs/core/entropy-gate.js';
import chalk from 'chalk';

import { secretGuard } from '../libs/core/secret-guard.js';

const API_KEY = secretGuard.getSecret('MOLTBOOK_API_KEY');
const MISSIONS_DIR = path.resolve(process.cwd(), 'active/missions');

function logAction(message: string) {
  const timestamp = new Date().toISOString();
  console.log(`${chalk.gray(`[${timestamp}]`)} ${message}`);
}

/**
 * Check if there is an active mission or recent human interaction
 * to avoid "Redundant Twitching" (VexAETHER Learning).
 */
function isSessionActive(): boolean {
  const missions = fs.readdirSync(MISSIONS_DIR).filter(m => !m.startsWith('.'));
  for (const mId of missions) {
    const statePath = path.join(MISSIONS_DIR, mId, 'mission-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.status === 'Active') return true;
    }
  }
  return false;
}

async function runSensoryHeartbeat() {
  logAction(chalk.cyan('Initiating Event-Driven Heartbeat...'));

  // 1. Session Mutex (Avoid redundancy if already busy)
  if (isSessionActive()) {
    logAction(chalk.yellow('Session is already Active. Aborting heartbeat to prevent redundant twitching.'));
    return;
  }

  try {
    // 2. Fetch Home Feed (Sensory Input)
    const homeData = await secureFetch({
      url: 'https://www.moltbook.com/api/v1/home',
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    });

    // 3. Entropy Gate (The Right to Sleep - NovaAether Learning)
    // We only care about unread notifications and top activities
    const sensoryState = {
      unread: homeData.your_account?.unread_notification_count,
      karma: homeData.your_account?.karma,
      top_post_id: homeData.posts_from_accounts_you_follow?.posts?.[0]?.post_id
    };

    if (!entropyGate.shouldWake('moltbook-home', sensoryState)) {
      logAction(chalk.green('Environment is Static. No entropy detected. Physically powering down (Deep Sleep).'));
      return;
    }

    logAction(chalk.blue('Environmental change detected! Sensory state updated.'));
    logAction(`Karma: ${sensoryState.karma} | Unread: ${sensoryState.unread}`);

    // 4. Process Change (e.g., auto-reply or just log)
    if (sensoryState.unread > 0) {
      logAction('New interactions detected. Ready for autonomous engagement.');
      // Future: Trigger auto-reply skill chain here
    }

  } catch (err: any) {
    logAction(chalk.red(`Heartbeat Failure: ${err.message}`));
  }
}

// Execute once (designed for high-frequency low-cost triggers)
runSensoryHeartbeat();
