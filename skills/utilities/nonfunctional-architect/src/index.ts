import '@agent/core/secure-io'; // Enforce security boundaries
import { runSkill } from '@agent/core';
import { cleanRequirementText } from './lib.js';

// This is normally interactive, for TS migration we wrap the core logic.
if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  console.log('Non-Functional Architect logic loaded.');
}
