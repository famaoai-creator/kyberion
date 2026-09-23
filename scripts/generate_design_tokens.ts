import * as path from 'node:path';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

import {
  concatKyberionUiStylesheetSources,
  readKyberionDesignTokens,
  renderKyberionDesignTokenBlock,
  renderKyberionTailwindColorsBlock,
  renderKyberionUiStylesheet,
  renderKyberionUiTokenBlock,
  updateThemesJson,
  replaceTokenBlock,
  replaceUiTokenBlock,
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
// Concierge themes itself at runtime (/api/theme sets the legacy --kb-* vars),
// so it receives only the --kb-ui-* layer, never the legacy block.
const CONCIERGE_UI_TOKENS_CSS_PATH = path.join(
  ROOT,
  'presence/displays/concierge/src/app/kyberion-ui-tokens.css'
);
/** Every surface gets the component stylesheet next to its token file. */
export const KYBERION_UI_STYLESHEET_PATHS = [
  'presence/displays/chronos-mirror-v2/src/app/kyberion-ui.css',
  'presence/displays/operator-surface/src/app/kyberion-ui.css',
  'presence/displays/presence-studio/static/kyberion-ui.css',
  'presence/displays/computer-surface/static/kyberion-ui.css',
  'presence/displays/concierge/src/app/kyberion-ui.css',
].map((relativePath) => path.join(ROOT, relativePath));
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

export function readDesignTokenTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

function renderUpdatedFile(filePath: string, content: string): GeneratedFile | undefined {
  if (!safeExistsSync(filePath)) return;
  const source = readDesignTokenTextFile(filePath);
  return content === source ? undefined : { path: filePath, content };
}

function renderTokenSurface(
  filePath: string,
  tokenBlock: string,
  uiTokenBlock: string
): GeneratedFile | undefined {
  if (!safeExistsSync(filePath)) return;
  const source = readDesignTokenTextFile(filePath);
  return renderUpdatedFile(
    filePath,
    replaceUiTokenBlock(replaceTokenBlock(source, tokenBlock), uiTokenBlock)
  );
}

function renderWholeFile(filePath: string, content: string): GeneratedFile | undefined {
  if (safeExistsSync(filePath) && readDesignTokenTextFile(filePath) === content) return;
  return { path: filePath, content };
}

function renderTailwindConfig(filePath: string): GeneratedFile | undefined {
  if (!safeExistsSync(filePath)) return;
  const source = readDesignTokenTextFile(filePath);
  const next = source.replace(
    /        kyberion: \{[\s\S]*?\n        \}/m,
    renderKyberionTailwindColorsBlock()
  );
  return renderUpdatedFile(filePath, next);
}

function renderThemesCatalog(
  filePath: string,
  tokens: ReturnType<typeof readKyberionDesignTokens>,
  includeDefaultTheme: boolean
): GeneratedFile | undefined {
  if (!safeExistsSync(filePath)) return;
  const source = readDesignTokenTextFile(filePath);
  const next = updateThemesJson(source, tokens, { includeDefaultTheme });
  return renderUpdatedFile(filePath, next);
}

function render(): GeneratedFile[] {
  const tokens = readKyberionDesignTokens();
  const tokenBlock = renderKyberionDesignTokenBlock(tokens);
  const uiTokenBlock = renderKyberionUiTokenBlock(tokens);
  // Base kyberion-ui.source.css first, then every kyberion-ui.<part>.source.css.
  const uiStylesheet = renderKyberionUiStylesheet(
    concatKyberionUiStylesheetSources((relativePath) =>
      readDesignTokenTextFile(path.join(ROOT, relativePath))
    )
  );

  return [
    renderTokenSurface(GLOBALS_CSS_PATH, tokenBlock, uiTokenBlock),
    renderTokenSurface(OPERATOR_GLOBALS_CSS_PATH, tokenBlock, uiTokenBlock),
    renderTokenSurface(PRESENCE_TOKENS_CSS_PATH, tokenBlock, uiTokenBlock),
    renderTokenSurface(COMPUTER_TOKENS_CSS_PATH, tokenBlock, uiTokenBlock),
    renderWholeFile(CONCIERGE_UI_TOKENS_CSS_PATH, `${uiTokenBlock}\n`),
    ...KYBERION_UI_STYLESHEET_PATHS.map((filePath) => renderWholeFile(filePath, uiStylesheet)),
    renderTailwindConfig(TAILWIND_CONFIG_PATH),
    renderThemesCatalog(THEMES_JSON_PATH, tokens, true),
    renderThemesCatalog(THEMES_JSON_NESTED_PATH, tokens, false),
  ].filter((file): file is GeneratedFile => file !== undefined);
}

export const runGenerateDesignTokens = defineGenerator({
  id: 'design-tokens',
  outputs: [
    GLOBALS_CSS_PATH,
    OPERATOR_GLOBALS_CSS_PATH,
    PRESENCE_TOKENS_CSS_PATH,
    COMPUTER_TOKENS_CSS_PATH,
    CONCIERGE_UI_TOKENS_CSS_PATH,
    ...KYBERION_UI_STYLESHEET_PATHS,
    TAILWIND_CONFIG_PATH,
    THEMES_JSON_PATH,
    THEMES_JSON_NESTED_PATH,
  ],
  render,
});

if (
  isDirectScript(import.meta.url, 'generate_design_tokens.ts') ||
  isDirectScript(import.meta.url, 'generate_design_tokens.js')
)
  void runGenerateDesignTokens();
