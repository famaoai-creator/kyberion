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
    '--kb-panel-bg': palette.panelBg,
    '--kb-accent': palette.accent,
    '--kb-warning': palette.warning,
    '--kb-text-primary': palette.textPrimary,
    '--kb-text-secondary': palette.textSecondary,
    '--kb-font-sans': '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    '--kb-panel-radius': input.layoutFamily === 'vtuber-stage' ? '32px' : '24px',
    '--kb-surface-radius': input.layoutFamily === 'vtuber-stage' ? '30px' : '24px',
    '--kb-section-gap': input.layoutFamily === 'vtuber-stage' ? '28px' : '24px',
    '--kb-content-gap': input.motionProfile === 'guided-step' ? '18px' : '16px',
    '--kb-glow-cyan': `0 0 24px ${palette.glow}`,
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
  panelBg: string;
  accent: string;
  warning: string;
  textPrimary: string;
  textSecondary: string;
  glow: string;
} {
  if (layoutFamily === 'promo-spot') {
    return {
      panelBg: 'rgba(15, 23, 42, 0.9)',
      accent: '#f59e0b',
      warning: '#fb7185',
      textPrimary: '#f8fafc',
      textSecondary: 'rgba(248, 250, 252, 0.72)',
      glow: 'rgba(245, 158, 11, 0.42)',
    };
  }
  if (layoutFamily === 'vtuber-stage') {
    return {
      panelBg: 'rgba(15, 23, 42, 0.92)',
      accent: '#60a5fa',
      warning: '#22c55e',
      textPrimary: '#f8fafc',
      textSecondary: 'rgba(226, 232, 240, 0.78)',
      glow: 'rgba(96, 165, 250, 0.44)',
    };
  }
  return {
    panelBg: 'rgba(15, 23, 42, 0.86)',
    accent: '#3b82f6',
    warning: '#94a3b8',
    textPrimary: '#f8fafc',
    textSecondary: 'rgba(148, 163, 184, 0.86)',
    glow: 'rgba(59, 130, 246, 0.34)',
  };
}
