import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/bootstrap.ts
 * Environment-agnostic bootstrap script to establish reference to @agent/core.
 * Enforces the "Dist-Link Rule" from ts-base-stabilization-sop.md.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const sourceDir = path.join(rootDir, 'dist', 'libs', 'core'); // MUST point to dist
const targetParentDir = path.join(rootDir, 'node_modules', '@agent');
const coreLink = path.join(targetParentDir, 'core');

console.log('[Bootstrap] Enforcing SOP: Dist-Link Rule...');

try {
  // 1. Ensure dist/libs/core exists (otherwise linking is pointless)
  if (!fs.existsSync(sourceDir)) {
    console.error(`[Bootstrap] ERROR: Build artifacts not found at ${sourceDir}. Run 'npm run build' first.`);
    process.exit(1);
  }

  // 2. Ensure node_modules/@agent exists
  if (!fs.existsSync(targetParentDir)) {
    fs.mkdirSync(targetParentDir, { recursive: true });
  }

  // 3. Remove existing link
  if (fs.existsSync(coreLink)) {
    const stats = fs.lstatSync(coreLink);
    if (stats.isSymbolicLink()) {
      fs.unlinkSync(coreLink);
    } else {
      fs.rmSync(coreLink, { recursive: true, force: true });
    }
  }

  // 4. Create correct symbolic link
  const relativeSource = path.relative(targetParentDir, sourceDir);
  fs.symlinkSync(relativeSource, coreLink, 'dir');

  console.log(`[Bootstrap] SUCCESS: @agent/core -> ${relativeSource}`);
} catch (err: any) {
  console.error(`[Bootstrap] FAILED: ${err.message}`);
  process.exit(1);
}
