import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core';

const ROOT = pathResolver.rootDir();
const BRAND_TOKENS_PATH = path.join(ROOT, 'knowledge/public/design-patterns/brand-tokens/kyberion.json');
const GLOBALS_CSS_PATH = path.join(ROOT, 'presence/displays/chronos-mirror-v2/src/app/globals.css');
const OPERATOR_GLOBALS_CSS_PATH = path.join(ROOT, 'presence/displays/operator-surface/src/app/globals.css');
const PRESENCE_TOKENS_CSS_PATH = path.join(ROOT, 'presence/displays/presence-studio/static/design-tokens.css');
const COMPUTER_TOKENS_CSS_PATH = path.join(ROOT, 'presence/displays/computer-surface/static/design-tokens.css');
const TAILWIND_CONFIG_PATH = path.join(ROOT, 'presence/displays/chronos-mirror-v2/tailwind.config.cjs');
const THEMES_JSON_PATH = path.join(ROOT, 'knowledge/public/design-patterns/media-templates/themes.json');
const THEMES_JSON_NESTED_PATH = path.join(ROOT, 'knowledge/public/design-patterns/media-templates/themes/themes.json');

async function run() {
  const tokens = JSON.parse(safeReadFile(BRAND_TOKENS_PATH, { encoding: 'utf8' }) as string);
  const light = tokens.tokens.colors.light;
  const dark = tokens.tokens.colors.dark;
  const fonts = tokens.tokens.fonts;

  // 1. Generate globals.css snippet (replace in file)
  const cssVars = `
:root {
  --background: ${light.bg_main};
  --foreground: ${light.text_primary};
  --kb-bg-main: ${light.bg_main};
  --kb-panel-bg: ${light.panel_bg};
  --kb-primary: ${light.primary};
  --kb-secondary: ${light.secondary};
  --kb-accent: ${light.accent};
  --kb-warning: ${light.warning};
  --kb-text-primary: ${light.text_primary};
  --kb-text-secondary: ${light.text_secondary};
  --kb-font-sans: ${fonts.sans};
  --kb-font-mono: ${fonts.mono};
  --kb-blur: blur(12px);
  --kb-border: 1px solid rgba(148, 163, 184, 0.1);
  --kb-glow-cyan: 0 0 15px rgba(0, 242, 255, 0.4);
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: ${dark.bg_main};
    --foreground: ${dark.text_primary};
    --kb-bg-main: ${dark.bg_main};
    --kb-panel-bg: ${dark.panel_bg};
    --kb-primary: ${dark.primary};
    --kb-secondary: ${dark.secondary};
    --kb-accent: ${dark.accent};
    --kb-warning: ${dark.warning};
    --kb-text-primary: ${dark.text_primary};
    --kb-text-secondary: ${dark.text_secondary};
  }
}
`.trim();

  if (safeExistsSync(GLOBALS_CSS_PATH)) {
    let css = safeReadFile(GLOBALS_CSS_PATH, { encoding: 'utf8' }) as string;
    // Remove old :root and @media blocks
    css = css.replace(/:root\s*{[\s\S]*?}(?:\s*@media\s*\(prefers-color-scheme:\s*dark\)\s*{\s*:root\s*{[\s\S]*?}\s*})?/m, cssVars);
    safeWriteFile(GLOBALS_CSS_PATH, css);
    console.log('Updated globals.css');
  }

  safeWriteFile(OPERATOR_GLOBALS_CSS_PATH, cssVars + '\n');
  console.log('Updated operator-surface globals.css');

  safeWriteFile(PRESENCE_TOKENS_CSS_PATH, cssVars + '\n');
  console.log('Updated presence-studio design-tokens.css');

  safeWriteFile(COMPUTER_TOKENS_CSS_PATH, cssVars + '\n');
  console.log('Updated computer-surface design-tokens.css');

  // 2. Generate Tailwind colors
  if (safeExistsSync(TAILWIND_CONFIG_PATH)) {
    let tw = safeReadFile(TAILWIND_CONFIG_PATH, { encoding: 'utf8' }) as string;
    tw = tw.replace(/kyberion:\s*{[\s\S]*?}/, `kyberion: {
          bg_main: "var(--kb-bg-main)",
          panel_bg: "var(--kb-panel-bg)",
          primary: "var(--kb-primary)",
          secondary: "var(--kb-secondary)",
          accent: "var(--kb-accent)",
          warning: "var(--kb-warning)",
          text_primary: "var(--kb-text-primary)",
          text_secondary: "var(--kb-text-secondary)",
        }`);
    safeWriteFile(TAILWIND_CONFIG_PATH, tw);
    console.log('Updated tailwind.config.cjs');
  }

  // 3. Update themes.json
  const updateThemes = (p: string) => {
    if (safeExistsSync(p)) {
      const ts = JSON.parse(safeReadFile(p, { encoding: 'utf8' }) as string);
      if (ts.themes['kyberion-standard']) {
        ts.themes['kyberion-standard'].colors = {
          primary: light.primary,
          secondary: light.secondary,
          accent: light.accent,
          background: light.bg_main,
          text: light.text_primary
        };
        ts.themes['kyberion-standard'].fonts = {
          heading: fonts.sans,
          body: fonts.sans
        };
      }
      if (ts.themes['kyberion-sovereign']) {
        ts.themes['kyberion-sovereign'].colors = {
          primary: dark.primary,
          secondary: dark.secondary,
          accent: dark.accent,
          background: dark.bg_main,
          text: dark.text_primary
        };
        ts.themes['kyberion-sovereign'].fonts = {
          heading: fonts.sans,
          body: fonts.sans
        };
      }
      safeWriteFile(p, JSON.stringify(ts, null, 2) + '\n');
      console.log(`Updated ${path.basename(p)}`);
    }
  };
  updateThemes(THEMES_JSON_PATH);
  updateThemes(THEMES_JSON_NESTED_PATH);
}

run().catch(console.error);
