import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { loadDesignFoundation, renderFoundationStylesheet } from '@agent/core/design-foundation';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';
import { readDesignTokenTextFile } from './generate_design_tokens.js';

/**
 * KDS v2: emit the standalone `kyberion-ds.css` (--kds-* primitives, per-style
 * scopes and composition grid classes) from kyberion-foundation.json.
 */
export const FOUNDATION_STYLESHEET_FILE = path.join(
  pathResolver.rootDir(),
  'knowledge/public/design-patterns/web/kyberion-ds.css'
);

function render(): GeneratedFile[] {
  const foundation = loadDesignFoundation();
  if (!foundation) throw new Error('kyberion-foundation.json is missing or unreadable');
  const content = renderFoundationStylesheet(foundation);
  if (
    safeExistsSync(FOUNDATION_STYLESHEET_FILE) &&
    readDesignTokenTextFile(FOUNDATION_STYLESHEET_FILE) === content
  ) {
    return [];
  }
  return [{ path: FOUNDATION_STYLESHEET_FILE, content }];
}

export const runGenerateDesignFoundation = defineGenerator({
  id: 'design-foundation',
  outputs: [FOUNDATION_STYLESHEET_FILE],
  render,
});

if (
  isDirectScript(import.meta.url, 'generate_design_foundation.ts') ||
  isDirectScript(import.meta.url, 'generate_design_foundation.js')
)
  void runGenerateDesignFoundation();
