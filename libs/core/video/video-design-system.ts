import {
  composeWebDesignSystem,
  DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK,
  DEFAULT_CHRONOS_WEB_THEME_PACK,
} from '../web-design-system.js';
import { semanticToken } from '../semantic-design-tokens.js';
import type { VideoPresentationMode, VideoContentBrief } from './video-content-brief-contract.js';

export interface VideoModeDefaults {
  layout_family: string;
  motion_profile: string;
  background_color: string;
}

export function resolveVideoModeDefaults(mode: VideoPresentationMode): VideoModeDefaults {
  if (mode === 'promo') {
    return {
      layout_family: 'promo-spot',
      motion_profile: 'energetic',
      background_color: semanticToken('video', 'video.mode.promo.background'),
    };
  }
  if (mode === 'vtuber') {
    return {
      layout_family: 'vtuber-stage',
      motion_profile: 'on-air',
      background_color: semanticToken('video', 'video.mode.vtuber.background'),
    };
  }
  return {
    layout_family: 'process-flow',
    motion_profile: 'guided-step',
    background_color: semanticToken('video', 'video.mode.howto.background'),
  };
}

export function buildVideoDesignCssVars(input: {
  backgroundColor: string;
  layoutFamily: string;
  motionProfile: string;
  designSystemRef: VideoContentBrief['design_system_ref'];
}): Record<string, string> {
  const baseVars = composeWebDesignSystem(
    DEFAULT_CHRONOS_WEB_THEME_PACK,
    DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK
  ).css_vars;
  const palette = derivePalette(input.backgroundColor, input.layoutFamily);
  return {
    ...baseVars,
    '--kb-bg-main': input.backgroundColor,
    '--kb-bg-deep': palette.bgDeep,
    '--kb-bg-ink': palette.bgInk,
    '--kb-bg-surface': palette.bgSurface,
    '--kb-bg-surface-strong': palette.bgSurfaceStrong,
    '--kb-bg-deep-strong': palette.bgDeepStrong,
    '--kb-bg-deepest': palette.bgDeepest,
    '--kb-bg-canvas': palette.bgCanvas,
    '--kb-bg-canvas-strong': palette.bgCanvasStrong,
    '--kb-bg-canvas-deep': palette.bgCanvasDeep,
    '--kb-panel-bg': palette.panelBg,
    '--kb-panel-bg-strong': palette.panelBgStrong,
    '--kb-overlay-light': palette.overlayLight,
    '--kb-overlay-heavy': palette.overlayHeavy,
    '--kb-border-subtle': palette.borderSubtle,
    '--kb-shadow-soft': palette.shadowSoft,
    '--kb-shadow-strong': palette.shadowStrong,
    '--kb-accent': palette.accent,
    '--kb-accent-soft': palette.accentSoft,
    '--kb-accent-strong': palette.accentStrong,
    '--kb-accent-muted': palette.accentMuted,
    '--kb-accent-text': palette.accentText,
    '--kb-accent-blue': semanticToken('video', 'video.accent.blue'),
    '--kb-accent-blue-soft': semanticToken('video', 'video.accent.blue-soft'),
    '--kb-accent-blue-strong': semanticToken('video', 'video.accent.blue-strong'),
    '--kb-accent-blue-muted': semanticToken('video', 'video.accent.blue-muted'),
    '--kb-accent-blue-text': semanticToken('video', 'video.accent.blue-text'),
    '--kb-accent-orange': semanticToken('video', 'video.accent.orange'),
    '--kb-accent-orange-soft': semanticToken('video', 'video.accent.orange-soft'),
    '--kb-accent-orange-strong': semanticToken('video', 'video.accent.orange-strong'),
    '--kb-accent-orange-muted': semanticToken('video', 'video.accent.orange-muted'),
    '--kb-accent-green': semanticToken('video', 'video.accent.green'),
    '--kb-accent-green-soft': semanticToken('video', 'video.accent.green-soft'),
    '--kb-accent-green-strong': semanticToken('video', 'video.accent.green-strong'),
    '--kb-accent-green-muted': semanticToken('video', 'video.accent.green-muted'),
    '--kb-warning': palette.warning,
    '--kb-warning-soft': palette.warningSoft,
    '--kb-success': palette.success,
    '--kb-success-soft': palette.successSoft,
    '--kb-danger': palette.danger,
    '--kb-danger-soft': palette.dangerSoft,
    '--kb-text-primary': palette.textPrimary,
    '--kb-text-secondary': palette.textSecondary,
    '--kb-text-muted': palette.textMuted,
    '--kb-text-subtle': palette.textSubtle,
    '--kb-text-inverse': palette.textInverse,
    '--kb-font-sans': '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    '--kb-panel-radius': input.layoutFamily === 'vtuber-stage' ? '32px' : '24px',
    '--kb-surface-radius': input.layoutFamily === 'vtuber-stage' ? '30px' : '24px',
    '--kb-section-gap': input.layoutFamily === 'vtuber-stage' ? '28px' : '24px',
    '--kb-content-gap': input.motionProfile === 'guided-step' ? '18px' : '16px',
    '--kb-glow-cyan': `0 0 24px ${palette.glow}`,
    '--kb-glow-warning': `0 0 24px ${palette.warningGlow}`,
    '--kb-glow-success': `0 0 24px ${palette.successGlow}`,
    ...input.designSystemRef.css_vars,
  };
}

export function resolveDefaultVideoBackgroundColor(mode: VideoPresentationMode = 'howto'): string {
  return resolveVideoModeDefaults(mode).background_color;
}

function derivePalette(
  backgroundColor: string,
  layoutFamily: string
): {
  bgDeep: string;
  bgInk: string;
  bgSurface: string;
  bgSurfaceStrong: string;
  bgDeepStrong: string;
  bgDeepest: string;
  bgCanvas: string;
  bgCanvasStrong: string;
  bgCanvasDeep: string;
  panelBg: string;
  panelBgStrong: string;
  overlayLight: string;
  overlayHeavy: string;
  borderSubtle: string;
  shadowSoft: string;
  shadowStrong: string;
  accent: string;
  accentSoft: string;
  accentStrong: string;
  accentMuted: string;
  accentText: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  success: string;
  successSoft: string;
  warningGlow: string;
  successGlow: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textSubtle: string;
  textInverse: string;
  glow: string;
} {
  const family =
    layoutFamily === 'promo-spot' || layoutFamily === 'vtuber-stage' ? layoutFamily : 'default';
  const token = (key: string): string => semanticToken('video', `video.palette.${family}.${key}`);
  return {
    bgDeep: token('bgDeep'),
    bgInk: token('bgInk'),
    bgSurface: token('bgSurface'),
    bgSurfaceStrong: token('bgSurfaceStrong'),
    bgDeepStrong: token('bgDeepStrong'),
    bgDeepest: token('bgDeepest'),
    bgCanvas: token('bgCanvas'),
    bgCanvasStrong: token('bgCanvasStrong'),
    bgCanvasDeep: token('bgCanvasDeep'),
    panelBg: token('panelBg'),
    panelBgStrong: token('panelBgStrong'),
    overlayLight: token('overlayLight'),
    overlayHeavy: token('overlayHeavy'),
    borderSubtle: token('borderSubtle'),
    shadowSoft: token('shadowSoft'),
    shadowStrong: token('shadowStrong'),
    accent: token('accent'),
    accentSoft: token('accentSoft'),
    accentStrong: token('accentStrong'),
    accentMuted: token('accentMuted'),
    accentText: token('accentText'),
    warning: token('warning'),
    warningSoft: token('warningSoft'),
    danger: token('danger'),
    dangerSoft: token('dangerSoft'),
    success: token('success'),
    successSoft: token('successSoft'),
    warningGlow: token('warningGlow'),
    successGlow: token('successGlow'),
    textPrimary: token('textPrimary'),
    textSecondary: token('textSecondary'),
    textMuted: token('textMuted'),
    textSubtle: token('textSubtle'),
    textInverse: token('textInverse'),
    glow: token('glow'),
  };
}
