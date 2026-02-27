import { runAsyncSkill } from '@agent/core';
import { runE2EJourney } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('ecosystem-integration-test', async () => {
    const results = await runE2EJourney();
    const allPassed = results.every((r) => r.status === 'success');
    return {
      status: allPassed ? 'success' : 'failed',
      journey: results,
    };
  });
}
