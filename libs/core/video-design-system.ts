import {
  composeWebDesignSystem,
  DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK,
  DEFAULT_CHRONOS_WEB_THEME_PACK,
} from './web-design-system.js';
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
      background_color: '#08101e',
    };
  }
  if (mode === 'vtuber') {
    return {
      layout_family: 'vtuber-stage',
      motion_profile: 'on-air',
      background_color: '#090814',
    };
  }
  return {
    layout_family: 'process-flow',
    motion_profile: 'guided-step',
    background_color: '#07111f',
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
    '--kb-accent-blue': '#60a5fa',
    '--kb-accent-blue-soft': '#93c5fd',
    '--kb-accent-blue-strong': 'rgba(96,165,250,0.44)',
    '--kb-accent-blue-muted': '#cfe3ff',
    '--kb-accent-blue-text': '#bfdbfe',
    '--kb-accent-orange': '#f59e0b',
    '--kb-accent-orange-soft': 'rgba(249,115,22,0.18)',
    '--kb-accent-orange-strong': 'rgba(249,115,22,0.24)',
    '--kb-accent-orange-muted': '#fed7aa',
    '--kb-accent-green': '#22c55e',
    '--kb-accent-green-soft': 'rgba(34,197,94,0.18)',
    '--kb-accent-green-strong': 'rgba(34,197,94,0.42)',
    '--kb-accent-green-muted': '#bbf7d0',
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
  if (layoutFamily === 'promo-spot') {
    return {
      bgDeep: '#0b1224',
      bgInk: '#07111f',
      bgSurface: '#09111f',
      bgSurfaceStrong: '#070912',
      bgDeepStrong: '#050814',
      bgDeepest: '#050714',
      bgCanvas: '#060913',
      bgCanvasStrong: '#050814',
      bgCanvasDeep: '#050714',
      panelBg: 'rgba(15, 23, 42, 0.9)',
      panelBgStrong: 'rgba(15, 23, 42, 0.96)',
      overlayLight: 'rgba(255,255,255,0.03)',
      overlayHeavy: 'rgba(255,255,255,0.1)',
      borderSubtle: 'rgba(148,163,184,0.12)',
      shadowSoft: 'rgba(0,0,0,0.25)',
      shadowStrong: 'rgba(0,0,0,0.45)',
      accent: '#f59e0b',
      accentSoft: 'rgba(249,115,22,0.18)',
      accentStrong: 'rgba(249,115,22,0.24)',
      accentMuted: '#fed7aa',
      accentText: '#cfe3ff',
      warning: '#fb7185',
      warningSoft: 'rgba(251,113,133,0.2)',
      danger: '#dc2626',
      dangerSoft: '#fecaca',
      success: '#22c55e',
      successSoft: '#bbf7d0',
      warningGlow: 'rgba(245, 158, 11, 0.42)',
      successGlow: 'rgba(34,197,94,0.42)',
      textPrimary: '#f8fafc',
      textSecondary: 'rgba(248, 250, 252, 0.72)',
      textMuted: '#94a3b8',
      textSubtle: '#64748b',
      textInverse: '#fff',
      glow: 'rgba(245, 158, 11, 0.42)',
    };
  }
  if (layoutFamily === 'vtuber-stage') {
    return {
      bgDeep: '#0b1224',
      bgInk: '#07111f',
      bgSurface: '#09111f',
      bgSurfaceStrong: '#070912',
      bgDeepStrong: '#050814',
      bgDeepest: '#050714',
      bgCanvas: '#060913',
      bgCanvasStrong: '#050814',
      bgCanvasDeep: '#050714',
      panelBg: 'rgba(15, 23, 42, 0.92)',
      panelBgStrong: 'rgba(15, 23, 42, 0.97)',
      overlayLight: 'rgba(255,255,255,0.03)',
      overlayHeavy: 'rgba(255,255,255,0.1)',
      borderSubtle: 'rgba(148,163,184,0.14)',
      shadowSoft: 'rgba(0,0,0,0.28)',
      shadowStrong: 'rgba(0,0,0,0.5)',
      accent: '#60a5fa',
      accentSoft: 'rgba(59,130,246,0.16)',
      accentStrong: 'rgba(96,165,250,0.24)',
      accentMuted: '#cfe3ff',
      accentText: '#bfdbfe',
      warning: '#22c55e',
      warningSoft: 'rgba(34,197,94,0.18)',
      danger: '#dc2626',
      dangerSoft: '#fecaca',
      success: '#22c55e',
      successSoft: '#bbf7d0',
      warningGlow: 'rgba(34,197,94,0.42)',
      successGlow: 'rgba(34,197,94,0.42)',
      textPrimary: '#f8fafc',
      textSecondary: 'rgba(226, 232, 240, 0.78)',
      textMuted: '#94a3b8',
      textSubtle: '#64748b',
      textInverse: '#fff',
      glow: 'rgba(96, 165, 250, 0.44)',
    };
  }
  return {
    bgDeep: '#0b1224',
    bgInk: '#07111f',
    bgSurface: '#09111f',
    bgSurfaceStrong: '#070912',
    bgDeepStrong: '#050814',
    bgDeepest: '#050714',
    bgCanvas: '#060913',
    bgCanvasStrong: '#050814',
    bgCanvasDeep: '#050714',
    panelBg: 'rgba(15, 23, 42, 0.86)',
    panelBgStrong: 'rgba(15, 23, 42, 0.95)',
    overlayLight: 'rgba(255,255,255,0.03)',
    overlayHeavy: 'rgba(255,255,255,0.1)',
    borderSubtle: 'rgba(148,163,184,0.16)',
    shadowSoft: 'rgba(0,0,0,0.24)',
    shadowStrong: 'rgba(0,0,0,0.45)',
    accent: '#3b82f6',
    accentSoft: 'rgba(59,130,246,0.16)',
    accentStrong: 'rgba(59,130,246,0.24)',
    accentMuted: '#cfe3ff',
    accentText: '#bfdbfe',
    warning: '#94a3b8',
    warningSoft: 'rgba(148,163,184,0.2)',
    danger: '#dc2626',
    dangerSoft: '#fecaca',
    success: '#22c55e',
    successSoft: '#bbf7d0',
    warningGlow: 'rgba(148,163,184,0.34)',
    successGlow: 'rgba(34,197,94,0.34)',
    textPrimary: '#f8fafc',
    textSecondary: 'rgba(148, 163, 184, 0.86)',
    textMuted: '#94a3b8',
    textSubtle: '#64748b',
    textInverse: '#fff',
    glow: 'rgba(59, 130, 246, 0.34)',
  };
}
