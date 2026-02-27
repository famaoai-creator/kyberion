import '@agent/core/secure-io'; // Enforce security boundaries
import { runSkill } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';
import { getAgentActivity } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('agent-activity-monitor', () => {
    const rootDir = pathResolver.rootDir();
    const { commits, stats } = getAgentActivity('famaoai', '24 hours ago', rootDir);

    return {
      period: 'Last 24 Hours',
      activity: {
        commitCount: commits.length,
        recentCommits: commits.slice(0, 5),
        diffStats: stats.trim(),
      },
      impact: { estimatedHumanHoursSaved: commits.length * 0.5 },
    };
  });
}
