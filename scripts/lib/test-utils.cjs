/**
 * Simple test helper for skill unit tests.
 * Zero-dependency alternative to Mocha/Jest.
 */
const assert = require('assert');

function describe(name, fn) {
    console.log(`
DESCRIBE: ${name}`);
    fn();
}

async function it(name, fn) {
    try {
        await fn();
        console.log(`  [PASS] ${name}`);
    } catch (e) {
        console.log(`  [FAIL] ${name}`);
        console.error(e);
        process.exit(1);
    }
}

module.exports = { describe, it, assert };
