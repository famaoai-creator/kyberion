/**
 * presence/sensors/task-watcher.ts
 * Proactive Task Watcher Sensor v1.0
 * Periodically checks for assigned GitHub issues and Jira tickets.
 */

import { PollingSensor, logger, safeExec } from '@agent/core';

class TaskWatcher extends PollingSensor {
  private lastKnownIssues: string[] = [];

  constructor() {
    super({
      id: 'task-watcher',
      name: 'GitHub/Jira Task Watcher',
      type: 'polling',
      interval_ms: 300000, // 5 minutes
      description: 'Monitors assigned tasks across external platforms.'
    });
  }

  /**
   * Proactive check logic
   */
  async poll() {
    logger.info('🔍 [TaskWatcher] Checking for new assigned tasks...');
    
    try {
      // 1. Check GitHub Issues via gh CLI (Physical approach)
      const output = await safeExec('gh', ['issue', 'list', '--assignee', '@me', '--json', 'id,title,url']);
      const issues = JSON.parse(output);
      
      const newIssues = issues.filter((iss: any) => !this.lastKnownIssues.includes(iss.id));
      
      if (newIssues.length > 0) {
        logger.success(`📬 [TaskWatcher] Found ${newIssues.length} new tasks!`);
        
        newIssues.forEach((iss: any) => {
          this.emit({
            intent: 'TASK_ASSIGNED',
            payload: {
              source: 'github',
              title: iss.title,
              url: iss.url,
              id: iss.id
            },
            priority: 7 // High priority for new assignments
          });
          this.lastKnownIssues.push(iss.id);
        });
      }
    } catch (err: any) {
      if (err.message.includes('gh: command not found')) {
        logger.warn('⚠️ [TaskWatcher] gh CLI not found. Skipping GitHub check.');
      } else {
        logger.error(`❌ [TaskWatcher] GitHub check failed: ${err.message}`);
      }
    }
  }
}

// Start the daemon if executed directly
const watcher = new TaskWatcher();
watcher.start().catch(err => {
  logger.error(`CRITICAL: TaskWatcher failed to start: ${err.message}`);
  process.exit(1);
});
