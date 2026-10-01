import * as assert from 'node:assert';

/**
 * Simple test helper for skill unit tests.
 */

export function describe(name: string, fn: () => void) {
  console.log(`\nDESCRIBE: ${name}`);
  fn();
}

export async function it(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    console.log(`  [FAIL] ${name}`);
    console.error(e);
    process.exit(1);
  }
}

export { assert };
