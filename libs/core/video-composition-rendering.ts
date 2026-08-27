import {
  visualDirectionToCssVars,
  normalizeVideoVisualDirection,
  type VideoVisualDirection,
} from './video-visual-direction.js';
import {
  motionDirectionToCss,
  normalizeVideoMotionDirection,
  type VideoMotionDirection,
} from './video-motion-direction.js';
import {
  normalizeSceneComposition,
  sceneCompositionToCss,
  type SceneComposition,
} from './video-scene-composition.js';
import { buildVideoDesignCssVars } from './video-design-system.js';
import { slugify } from './foundation/text.js';
import { escapeHtml } from './text-escaping.js';
import type {
  CompiledVideoCompositionScene,
  VideoCompositionADF,
  VideoCompositionAssetRef,
  VideoCompositionScene,
} from './video-composition-contract.js';

function sceneThemeLayoutFamily(scene: CompiledVideoCompositionScene): string {
  return String(
    scene.content?.layout_family || scene.content?.layout_variant || scene.template_id || 'default'
  );
}

function sceneThemeMotionProfile(scene: CompiledVideoCompositionScene): string {
  return String(scene.content?.motion_profile || scene.content?.motion || 'guided-step');
}

function normalizeSceneDesignSystemVars(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (acc, [key, entry]) => {
      if (
        /^--kb-[a-z0-9-]+$/u.test(key) &&
        typeof entry === 'string' &&
        entry.trim() &&
        entry.length <= 512 &&
        !/[<>{};\u0000\r\n]/u.test(entry)
      ) {
        acc[key] = entry.trim();
      }
      return acc;
    },
    {}
  );
}

function buildSceneCssVars(
  scene: CompiledVideoCompositionScene,
  adf: VideoCompositionADF
): Record<string, string> {
  const designSystemVars = normalizeSceneDesignSystemVars(scene.content?.design_system_vars);
  const background =
    designSystemVars['--kb-bg-main'] ||
    designSystemVars['--bg'] ||
    adf.composition.background_color ||
    '#07111f';
  const themeVars = buildVideoDesignCssVars({
    backgroundColor: background,
    layoutFamily: sceneThemeLayoutFamily(scene),
    motionProfile: sceneThemeMotionProfile(scene),
    designSystemRef: { system_id: 'video-composition', css_vars: designSystemVars },
  });
  return {
    ...themeVars,
    '--bg': `var(--kb-bg-main, ${themeVars['--kb-bg-main'] || background})`,
    '--panel': `var(--kb-panel-bg, ${themeVars['--kb-panel-bg'] || 'rgba(15, 23, 42, 0.88)'})`,
    '--accent': `var(--kb-accent, ${themeVars['--kb-accent'] || '#60a5fa'})`,
    '--text': `var(--kb-text-primary, ${themeVars['--kb-text-primary'] || '#f8fafc'})`,
    '--subtext': `var(--kb-text-secondary, ${themeVars['--kb-text-secondary'] || '#94a3b8'})`,
    '--font-sans': `var(--kb-font-sans, ${themeVars['--kb-font-sans'] || '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'})`,
    '--headline-size': `var(--kb-size-headline, ${designSystemVars['--kb-size-headline'] || '68px'})`,
    '--body-size': `var(--kb-size-body, ${designSystemVars['--kb-size-body'] || '23px'})`,
    '--title-size': `var(--kb-size-title, ${designSystemVars['--kb-size-title'] || '42px'})`,
    '--label-size': `var(--kb-size-label, ${designSystemVars['--kb-size-label'] || '16px'})`,
    '--font-heading': `var(--kb-font-heading, ${designSystemVars['--kb-font-heading'] || '"Inter", sans-serif'})`,
    '--font-body': `var(--kb-font-body, ${designSystemVars['--kb-font-body'] || '"Inter", sans-serif'})`,
    '--space-unit': `var(--kb-space-unit, ${designSystemVars['--kb-space-unit'] || '4px'})`,
    '--safe-area': `var(--kb-safe-area, ${designSystemVars['--kb-safe-area'] || '5%'})`,
    '--radius-panel': `var(--kb-panel-radius, ${themeVars['--kb-panel-radius'] || '32px'})`,
    '--radius-surface': `var(--kb-surface-radius, ${themeVars['--kb-surface-radius'] || '24px'})`,
  };
}

export function renderSceneCssVars(
  scene: CompiledVideoCompositionScene,
  adf: VideoCompositionADF
): string {
  const lines = Object.entries(buildSceneCssVars(scene, adf))
    .map(([key, value]) => `      ${key}: ${value};`)
    .join('\n');
  return `:root {\n${lines}\n    }`;
}

export function resolveAsset(
  assetRefs: VideoCompositionAssetRef[],
  role: VideoCompositionAssetRef['role']
): VideoCompositionAssetRef | undefined {
  return assetRefs.find((asset) => asset.role === role) || assetRefs[0];
}

export function mergeSceneAssetRefs(
  declaredAssetRefs: VideoCompositionAssetRef[],
  inferredAssetRefs: VideoCompositionAssetRef[]
): VideoCompositionAssetRef[] {
  const seen = new Set<string>();
  const merged: VideoCompositionAssetRef[] = [];
  for (const asset of [...declaredAssetRefs, ...inferredAssetRefs]) {
    const key = `${asset.role || 'asset'}:${asset.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...asset });
  }
  return merged;
}

export function extractAvatarAssetRefs(scene: VideoCompositionScene): VideoCompositionAssetRef[] {
  const avatarAssets = scene.content?.avatar_assets;
  if (!avatarAssets || typeof avatarAssets !== 'object') return [];
  return Object.entries(avatarAssets as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => ({
      asset_id: `${safeSceneKey(scene.scene_id)}-avatar-${safeSceneKey(key)}`,
      path: String(value),
      role: 'supporting' as const,
    }));
}

export function resolveAvatarAsset(
  scene: CompiledVideoCompositionScene,
  supporting?: VideoCompositionAssetRef
): VideoCompositionAssetRef | undefined {
  const avatarAssets = scene.content?.avatar_assets;
  if (avatarAssets && typeof avatarAssets === 'object') {
    const variantKey = String(
      scene.content?.layout_variant || scene.content?.semantic || scene.role || ''
    ).toLowerCase();
    const avatarRecord = avatarAssets as Record<string, unknown>;
    const candidate = [
      avatarRecord[variantKey],
      avatarRecord[scene.role as string],
      avatarRecord[String(scene.content?.semantic || '').toLowerCase()],
      avatarRecord.default,
    ].find((value) => typeof value === 'string' && value.trim());
    if (typeof candidate === 'string') {
      return {
        asset_id: `${safeSceneKey(scene.scene_id)}-avatar`,
        path: candidate,
        role: 'supporting',
      };
    }
  }
  return supporting;
}

function safeSceneKey(value: string): string {
  return slugify(String(value || 'scene'), { maxLength: 64, fallback: 'video-composition' });
}

function tokenizeVideoCss(css: string): string {
  css = css
    .replace(/font-size:\s*68px/gi, 'font-size: var(--headline-size, 68px)')
    .replace(/font-size:\s*23px/gi, 'font-size: var(--body-size, 23px)');
  const tokenized = [
    { pattern: /#0B1020/gi, token: '--kb-bg-main' },
    { pattern: /#0b1224/gi, token: '--kb-bg-deep' },
    { pattern: /#09111f/gi, token: '--kb-bg-surface' },
    { pattern: /#07111f/gi, token: '--kb-bg-ink' },
    { pattern: /#070912/gi, token: '--kb-bg-surface-strong' },
    { pattern: /#060913/gi, token: '--kb-bg-canvas' },
    { pattern: /#050814/gi, token: '--kb-bg-deep-strong' },
    { pattern: /#050714/gi, token: '--kb-bg-deepest' },
    { pattern: /#93c5fd/gi, token: '--kb-accent-blue-soft' },
    { pattern: /#60a5fa/gi, token: '--kb-accent-blue' },
    { pattern: /#bfdbfe/gi, token: '--kb-accent-blue-text' },
    { pattern: /#cfe3ff/gi, token: '--kb-accent-blue-muted' },
    { pattern: /#f59e0b/gi, token: '--kb-accent-orange' },
    { pattern: /#fed7aa/gi, token: '--kb-accent-orange-muted' },
    { pattern: /#fecaca/gi, token: '--kb-danger-soft' },
    { pattern: /#f8fafc/gi, token: '--kb-text-primary' },
    { pattern: /#e2e8f0/gi, token: '--kb-text-secondary' },
    { pattern: /#cbd5e1/gi, token: '--kb-text-secondary' },
    { pattern: /#94a3b8/gi, token: '--kb-text-muted' },
    { pattern: /#64748b/gi, token: '--kb-text-subtle' },
    { pattern: /#22c55e/gi, token: '--kb-accent-green' },
    { pattern: /#bbf7d0/gi, token: '--kb-accent-green-muted' },
    { pattern: /#fff/gi, token: '--kb-text-inverse' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.1\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.12\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.15\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.16\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.18\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.2\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.22\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.24\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.28\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.34\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.12\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.16\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.18\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.22\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.28\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.44\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.6\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*147,\s*197,\s*253,\s*0\s*\)/gi, token: '--kb-accent-blue-muted' },
    { pattern: /rgba\(\s*147,\s*197,\s*253,\s*0\.9\s*\)/gi, token: '--kb-accent-blue-muted' },
    { pattern: /rgba\(\s*249,\s*115,\s*22,\s*0\.14\s*\)/gi, token: '--kb-accent-orange-soft' },
    { pattern: /rgba\(\s*249,\s*115,\s*22,\s*0\.18\s*\)/gi, token: '--kb-accent-orange-soft' },
    { pattern: /rgba\(\s*249,\s*115,\s*22,\s*0\.2\s*\)/gi, token: '--kb-accent-orange-soft' },
    { pattern: /rgba\(\s*249,\s*115,\s*22,\s*0\.22\s*\)/gi, token: '--kb-accent-orange-soft' },
    { pattern: /rgba\(\s*245,\s*158,\s*11,\s*0\.42\s*\)/gi, token: '--kb-glow-warning' },
    { pattern: /rgba\(\s*34,\s*197,\s*94,\s*0\.12\s*\)/gi, token: '--kb-accent-green-soft' },
    { pattern: /rgba\(\s*34,\s*197,\s*94,\s*0\.14\s*\)/gi, token: '--kb-accent-green-soft' },
    { pattern: /rgba\(\s*34,\s*197,\s*94,\s*0\.18\s*\)/gi, token: '--kb-accent-green-soft' },
    { pattern: /rgba\(\s*34,\s*197,\s*94,\s*0\.5\s*\)/gi, token: '--kb-glow-success' },
    { pattern: /rgba\(\s*220,\s*38,\s*38,\s*0\.2\s*\)/gi, token: '--kb-danger-soft' },
    { pattern: /rgba\(\s*248,\s*113,\s*113,\s*0\.2\s*\)/gi, token: '--kb-danger-soft' },
    { pattern: /rgba\(\s*148,\s*163,\s*184,\s*0\.12\s*\)/gi, token: '--kb-border-subtle' },
    { pattern: /rgba\(\s*148,\s*163,\s*184,\s*0\.14\s*\)/gi, token: '--kb-border-subtle' },
    { pattern: /rgba\(\s*148,\s*163,\s*184,\s*0\.16\s*\)/gi, token: '--kb-border-subtle' },
    { pattern: /rgba\(\s*148,\s*163,\s*184,\s*0\.18\s*\)/gi, token: '--kb-border-subtle' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.82\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.86\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.88\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.9\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.92\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.95\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.96\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.6\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.7\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.76\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.9\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.94\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*255,\s*255,\s*255,\s*0\.03\s*\)/gi, token: '--kb-overlay-light' },
    { pattern: /rgba\(\s*255,\s*255,\s*255,\s*0\.1\s*\)/gi, token: '--kb-overlay-heavy' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.24\s*\)/gi, token: '--kb-shadow-soft' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.25\s*\)/gi, token: '--kb-shadow-soft' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.3\s*\)/gi, token: '--kb-shadow-soft' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.35\s*\)/gi, token: '--kb-shadow-strong' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.45\s*\)/gi, token: '--kb-shadow-strong' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.5\s*\)/gi, token: '--kb-shadow-strong' },
  ];
  return tokenized.reduce(
    (result, entry) => result.replace(entry.pattern, (match) => `var(${entry.token}, ${match})`),
    css
  );
}

export function resolveAdfVisualDirection(adf: VideoCompositionADF): VideoVisualDirection {
  return normalizeVideoVisualDirection(adf.composition.visual_direction, {
    width: adf.composition.width,
    height: adf.composition.height,
  });
}

export function resolveAdfMotionDirection(adf: VideoCompositionADF): VideoMotionDirection {
  return normalizeVideoMotionDirection(
    adf.composition.motion_direction,
    adf.scenes.map((scene) => ({
      scene_id: scene.scene_id,
      role: scene.role,
      duration_sec: scene.duration_sec,
    }))
  );
}

export function applySceneComposition(
  html: string,
  scene: CompiledVideoCompositionScene,
  compositions: SceneComposition[] | undefined
): string {
  if (!compositions?.length) return html;
  const drafted = compositions.find((entry) => entry.scene_id === scene.scene_id);
  if (!drafted) return html;
  const composition = normalizeSceneComposition(drafted, {
    scene_id: scene.scene_id,
    role: scene.role,
    available_keys: Object.keys(scene.content ?? {}).filter(
      (key) => scene.content[key] !== undefined && scene.content[key] !== null
    ),
  });
  const css = sceneCompositionToCss(composition);
  if (!css.trim()) return html;
  const block = `<style data-kb-composition="${escapeHtml(composition.layout)}">\n${css}\n</style>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${block}\n</head>`)
    : `${block}\n${html}`;
}

export function applySceneMotion(
  html: string,
  scene: CompiledVideoCompositionScene,
  direction: VideoMotionDirection
): string {
  const sceneMotion = direction.scenes.find((entry) => entry.scene_id === scene.scene_id);
  if (!sceneMotion) return html;
  const css = motionDirectionToCss({ scenes: [sceneMotion], transitions: [] }, undefined, {
    entrance: '.composition-root, body > .shell, body > .stack',
    layers: [
      'h1, .headline, .hero-text, .quote-text',
      '.visual, .panel, .process-visual, .proof-row, img',
    ],
  });
  if (!css.trim()) return html;
  const block = `<style data-kb-motion="${escapeHtml(sceneMotion.entrance.pattern_id)}">\n${css}\n</style>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${block}\n</head>`)
    : `${block}\n${html}`;
}

export function applyVideoThemeTokens(html: string, direction?: VideoVisualDirection): string {
  const tokenized = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attrs, css) => {
    return `<style${attrs}>${tokenizeVideoCss(css)}</style>`;
  });
  if (!direction) return tokenized;
  const rootVars = `<style data-kb-visual-direction="${escapeHtml(direction.mood)}">\n${visualDirectionToCssVars(direction)}\n</style>`;
  return tokenized.includes('</head>')
    ? tokenized.replace('</head>', `${rootVars}\n</head>`)
    : `${rootVars}\n${tokenized}`;
}
