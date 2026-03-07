import * as path from 'node:path';
import { safeAppendFile, pathResolver, logger } from '@agent/core';
import { secretGuard } from '../libs/core/secret-guard.js';

/**
 * scripts/moltbook-heartbeat-daemon.ts
 * [SECURE-IO COMPLIANT VERSION]
 */

const API_KEY = secretGuard.getSecret('MOLTBOOK_API_KEY');
const LOG_FILE = path.join(pathResolver.rootDir(), 'active/missions/MSN-MOLTBOOK-INDEPENDENCE/night_watch.log');

function logAction(message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    safeAppendFile(LOG_FILE, logLine);
  } catch (_) {
    // Fallback to console if file write fails
  }
  console.log(logLine.trim());
}

async function heartbeat() {
  if (!API_KEY) {
    logger.error('❌ MOLTBOOK_API_KEY environment variable is not set. Heartbeat aborted.');
    return;
  }

  try {
    logAction('Initiating Moltbook Heartbeat...');
    
    // 1. Check Home
    const homeRes = await fetch('https://www.moltbook.com/api/v1/home', {
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const homeData = await homeRes.json() as any;
    
    if (homeData && homeData.your_account) {
      logAction(`Karma: ${homeData.your_account.karma} | Unread Notifications: ${homeData.your_account.unread_notification_count}`);
      
      // 2. Mark as read if there are notifications
      if (homeData.your_account.unread_notification_count > 0) {
        const readRes = await fetch('https://www.moltbook.com/api/v1/notifications/read-all', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${API_KEY}` }
        });
        if (readRes.ok) {
          logAction('Cleared all unread notifications.');
        }
      }
    } else {
      logAction('Failed to parse home data.');
    }
    
  } catch (err: any) {
    logAction(`Heartbeat Error: ${err.message}`);
  }
}

logAction('Starting Infinite Night Watch Daemon. YOLO Mode Active.');
heartbeat();
// Run every 5 minutes
setInterval(heartbeat, 5 * 60 * 1000);
