import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core';

import {
  readKyberionDesignTokens,
  renderKyberionDesignTokenBlock,
  renderKyberionTailwindColorsBlock,
  updateThemesJson,
  replaceTokenBlock,
} from './design-token-utils.js';

const ROOT = pathResolver.rootDir();
const GLOBALS_CSS_PATH = path.join(ROOT, 'presence/displays/chronos-mirror-v2/src/app/globals.css');
const OPERATOR_GLOBALS_CSS_PATH = path.join(
  ROOT,
  'presence/displays/operator-surface/src/app/globals.css'
);
const PRESENCE_TOKENS_CSS_PATH = path.join(
  ROOT,
  'presence/displays/presence-studio/static/design-tokens.css'
);
const COMPUTER_TOKENS_CSS_PATH = path.join(
  ROOT,
  'presence/displays/computer-surface/static/design-tokens.css'
);
const TAILWIND_CONFIG_PATH = path.join(
  ROOT,
  'presence/displays/chronos-mirror-v2/tailwind.config.cjs'
);
const THEMES_JSON_PATH = path.join(
  ROOT,
  'knowledge/public/design-patterns/media-templates/themes.json'
);
const THEMES_JSON_NESTED_PATH = path.join(
  ROOT,
  'knowledge/public/design-patterns/media-templates/themes/themes.json'
);

function updateTokenSurface(filePath: string, tokenBlock: string) {
  if (!safeExistsSync(filePath)) return;
  const source = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  const next = replaceTokenBlock(source, tokenBlock);
  if (next !== source) {
    safeWriteFile(filePath, next);
    console.log(`Updated ${path.relative(ROOT, filePath)}`);
  }
}

function updateTailwindConfig(filePath: string) {
  if (!safeExistsSync(filePath)) return;
  const source = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  const next = source.replace(
    /        kyberion: \{[\s\S]*?\n        \}/m,
    renderKyberionTailwindColorsBlock()
  );
  if (next !== source) {
    safeWriteFile(filePath, next);
    console.log('Updated tailwind.config.cjs');
  }
}

function updateThemesCatalog(
  filePath: string,
  tokens: ReturnType<typeof readKyberionDesignTokens>,
  includeDefaultTheme: boolean
) {
  if (!safeExistsSync(filePath)) return;
  const source = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  const next = updateThemesJson(source, tokens, { includeDefaultTheme });
  if (next !== source) {
    safeWriteFile(filePath, next);
    console.log(`Updated ${path.relative(ROOT, filePath)}`);
  }
}

async function run() {
  const tokens = readKyberionDesignTokens();
  const tokenBlock = renderKyberionDesignTokenBlock(tokens);

  updateTokenSurface(GLOBALS_CSS_PATH, tokenBlock);
  updateTokenSurface(OPERATOR_GLOBALS_CSS_PATH, tokenBlock);
  updateTokenSurface(PRESENCE_TOKENS_CSS_PATH, tokenBlock);
  updateTokenSurface(COMPUTER_TOKENS_CSS_PATH, tokenBlock);
  updateTailwindConfig(TAILWIND_CONFIG_PATH);
  updateThemesCatalog(THEMES_JSON_PATH, tokens, true);
  updateThemesCatalog(THEMES_JSON_NESTED_PATH, tokens, false);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
