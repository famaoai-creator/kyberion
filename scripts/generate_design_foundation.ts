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
export const KYBERION_DS_CSS_PATH = path.join(
  pathResolver.rootDir(),
  'knowledge/public/design-patterns/web/kyberion-ds.css'
);

function render(): GeneratedFile[] {
  const foundation = loadDesignFoundation();
  if (!foundation) throw new Error('kyberion-foundation.json is missing or unreadable');
  const content = renderFoundationStylesheet(foundation);
  if (
    safeExistsSync(KYBERION_DS_CSS_PATH) &&
    readDesignTokenTextFile(KYBERION_DS_CSS_PATH) === content
  ) {
    return [];
  }
  return [{ path: KYBERION_DS_CSS_PATH, content }];
}

export const runGenerateDesignFoundation = defineGenerator({
  id: 'design-foundation',
  outputs: [KYBERION_DS_CSS_PATH],
  render,
});

if (
  isDirectScript(import.meta.url, 'generate_design_foundation.ts') ||
  isDirectScript(import.meta.url, 'generate_design_foundation.js')
)
  void runGenerateDesignFoundation();
