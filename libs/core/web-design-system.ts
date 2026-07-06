const KYBERION_BRAND_FONT_STACK = "Inter, 'Noto Sans JP', sans-serif";

export interface WebThemePack {
  kind: 'web-theme-pack';
  version: string;
  theme_id: string;
  brand_name: string;
  tenant_slug: string;
  design_system_id: string;
  theme: {
    name: string;
    colors: {
      primary: string;
      secondary: string;
      accent: string;
      background: string;
      text: string;
    };
    fonts: {
      heading: string;
      body: string;
    };
    assets?: {
      logo_url?: string;
    };
  };
  web: {
    source_url: string;
    snapshot_summary?: string;
    hero?: {
      title?: string;
      subtitle?: string;
      cta?: string;
    };
    layout_grid?: {
      type?: string;
      columns?: number;
      container_max_width?: string;
    };
    spacing_scale?: Record<string, string | number>;
    breakpoints?: string[];
    sections?: Array<string | Record<string, unknown>>;
    typography?: {
      heading?: string;
      body?: string;
    };
    snapshot?: Record<string, unknown> | string | null;
  };
  layout_templates?: {
    version?: string;
    default?: string;
    templates?: Record<string, Record<string, unknown>>;
  } | null;
  layout_template_id?: string;
  layout_template_catalog?: string | null;
  source_theme_name?: string | null;
}

export interface WebDesignSystemSlot {
  slot_id: string;
  role: string;
  required: boolean;
  min_items?: number;
  max_items?: number;
  max_chars_per_item?: number;
  notes?: string;
}

export interface WebDesignSystemConstraint {
  kind: 'single_message' | 'paired_item_counts_match' | 'balanced_copy' | 'requires_visual';
  slots?: string[];
  message?: string;
}

export interface WebDesignSystemSectionPattern {
  section_id: string;
  category: string;
  summary: string;
  purpose: string;
  layout_key: string;
  region_order: string[];
  slots: WebDesignSystemSlot[];
  constraints?: WebDesignSystemConstraint[];
}

export interface WebDesignSystemPack {
  kind: 'web-design-system-pack';
  version: string;
  pack_id: string;
  source: {
    name: string;
    repository?: string;
    revision?: string;
    notes?: string;
  };
  theme_id: string;
  design_system_id: string;
  layout: {
    container_max_width: string;
    grid_columns: number;
    sidebar_width: string;
    panel_radius: string;
    surface_radius: string;
    section_gap: string;
    content_gap: string;
    hero_min_height: string;
    body_line_height: number;
  };
  tokens: {
    button_radius: string;
    chip_radius: string;
    badge_radius: string;
    border_alpha: number;
    surface_alpha: number;
    muted_alpha: number;
  };
  section_order: string[];
  section_patterns: WebDesignSystemSectionPattern[];
}

export interface ResolvedWebDesignSystem {
  theme: WebThemePack;
  design_system: WebDesignSystemPack;
  layout: WebDesignSystemPack['layout'];
  section_order: string[];
  section_patterns: WebDesignSystemSectionPattern[];
  css_vars: Record<string, string>;
}

function hexToRgb(value: string): [number, number, number] | null {
  const normalized = String(value || '')
    .trim()
    .replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
    const parts = normalized.split('').map((entry) => Number.parseInt(`${entry}${entry}`, 16));
    return [parts[0], parts[1], parts[2]];
  }
  if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ];
  }
  return null;
}

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

export function webThemePackToCssVars(themePack: WebThemePack): Record<string, string> {
  const colors = themePack.theme.colors;
  return {
    '--kb-bg-main': colors.background,
    '--kb-panel-bg': rgba(colors.primary, 0.82),
    '--kb-accent': colors.accent,
    '--kb-warning': colors.secondary,
    '--kb-text-primary': colors.text,
    '--kb-text-secondary': rgba(colors.text, 0.62),
    '--kb-font-sans': themePack.theme.fonts.body,
    '--kb-font-mono': '"JetBrains Mono", monospace',
    '--kb-border': `1px solid ${rgba(colors.text, 0.1)}`,
    '--kb-glow-cyan': `0 0 15px ${rgba(colors.accent, 0.42)}`,
  };
}

export function composeWebDesignSystem(
  themePack: WebThemePack,
  designSystemPack: WebDesignSystemPack
): ResolvedWebDesignSystem {
  return {
    theme: themePack,
    design_system: designSystemPack,
    layout: designSystemPack.layout,
    section_order: designSystemPack.section_order,
    section_patterns: designSystemPack.section_patterns,
    css_vars: {
      ...webThemePackToCssVars(themePack),
      '--kb-container-max-width': designSystemPack.layout.container_max_width,
      '--kb-grid-columns': String(designSystemPack.layout.grid_columns),
      '--kb-sidebar-width': designSystemPack.layout.sidebar_width,
      '--kb-panel-radius': designSystemPack.layout.panel_radius,
      '--kb-surface-radius': designSystemPack.layout.surface_radius,
      '--kb-section-gap': designSystemPack.layout.section_gap,
      '--kb-content-gap': designSystemPack.layout.content_gap,
      '--kb-hero-min-height': designSystemPack.layout.hero_min_height,
      '--kb-button-radius': designSystemPack.tokens.button_radius,
      '--kb-chip-radius': designSystemPack.tokens.chip_radius,
      '--kb-badge-radius': designSystemPack.tokens.badge_radius,
      '--kb-border-alpha': String(designSystemPack.tokens.border_alpha),
      '--kb-surface-alpha': String(designSystemPack.tokens.surface_alpha),
      '--kb-muted-alpha': String(designSystemPack.tokens.muted_alpha),
    },
  };
}

export const DEFAULT_CHRONOS_WEB_THEME_PACK: WebThemePack = {
  kind: 'web-theme-pack',
  version: '1.0.0',
  theme_id: 'chronos-sovereign-command',
  brand_name: 'Chronos Mirror',
  tenant_slug: 'kyberion',
  design_system_id: 'chronos-command-surface',
  theme: {
    name: 'Chronos Sovereign Command',
    colors: {
      primary: '#0A192F',
      secondary: '#31415B',
      accent: '#00F2FF',
      background: '#020617',
      text: '#F8FAFC',
    },
    fonts: {
      heading: KYBERION_BRAND_FONT_STACK,
      body: KYBERION_BRAND_FONT_STACK,
    },
  },
  web: {
    source_url: 'https://kyberion.local/chronos-mirror-v2',
    snapshot_summary: 'Dense command surface for missions, agents, and traceable operator actions.',
    hero: {
      title: 'Chronos Mirror',
      subtitle:
        'A web control surface that keeps mission state, operator views, and runtime evidence in one place.',
      cta: 'Open command surface',
    },
    layout_grid: {
      type: 'grid',
      columns: 12,
      container_max_width: '1440px',
    },
    spacing_scale: {
      xs: '4px',
      sm: '8px',
      md: '16px',
      lg: '24px',
      xl: '40px',
    },
    breakpoints: ['640px', '1024px', '1280px'],
    sections: [
      'hero',
      'design-system',
      'quick-actions',
      'operator-views',
      'mission-intelligence',
      'trace-viewer',
    ],
    typography: {
      heading: 'Inter, sans-serif',
      body: 'Inter, sans-serif',
    },
  },
};

export const DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK: WebDesignSystemPack = {
  kind: 'web-design-system-pack',
  version: '1.0.0',
  pack_id: 'chronos-command-surface',
  source: {
    name: 'Kyberion Chronos Mirror v2',
    repository: 'https://github.com/sho-ai-magic/kyberion',
    notes: 'Web-specific structural system that pairs a theme pack with control-surface sections.',
  },
  theme_id: 'chronos-sovereign-command',
  design_system_id: 'chronos-command-surface',
  layout: {
    container_max_width: '1440px',
    grid_columns: 12,
    sidebar_width: '320px',
    panel_radius: '24px',
    surface_radius: '30px',
    section_gap: '24px',
    content_gap: '16px',
    hero_min_height: '240px',
    body_line_height: 1.55,
  },
  tokens: {
    button_radius: '999px',
    chip_radius: '999px',
    badge_radius: '12px',
    border_alpha: 0.1,
    surface_alpha: 0.8,
    muted_alpha: 0.62,
  },
  section_order: [
    'hero',
    'design-system',
    'quick-actions',
    'scenario-selector',
    'operator-views',
    'surface-cards',
    'mission-cycle',
  ],
  section_patterns: [
    {
      section_id: 'hero',
      category: 'hero',
      summary: 'Opening hero that explains the control surface and the active theme.',
      purpose: 'Introduce the site and the current web design system.',
      layout_key: 'hero-command-split',
      region_order: ['title', 'supporting_copy', 'actions', 'signals'],
      slots: [
        {
          slot_id: 'title',
          role: 'Primary title',
          required: true,
          max_items: 1,
          max_chars_per_item: 42,
        },
        {
          slot_id: 'supporting_copy',
          role: 'Supporting copy',
          required: true,
          max_items: 1,
          max_chars_per_item: 120,
        },
        {
          slot_id: 'actions',
          role: 'Primary actions',
          required: false,
          max_items: 3,
          max_chars_per_item: 24,
        },
        {
          slot_id: 'signals',
          role: 'Design system signals',
          required: false,
          max_items: 4,
          max_chars_per_item: 24,
        },
      ],
      constraints: [
        {
          kind: 'single_message',
          slots: ['title'],
          message: 'Keep the hero focused on one clear operating model.',
        },
      ],
    },
    {
      section_id: 'design-system',
      category: 'system',
      summary: 'Shows the active theme, grid, spacing, and section order.',
      purpose: 'Make the web design system visible rather than implicit.',
      layout_key: 'supporting-grid',
      region_order: ['theme', 'layout', 'tokens', 'sections'],
      slots: [
        {
          slot_id: 'theme',
          role: 'Theme tokens',
          required: true,
          max_items: 1,
          max_chars_per_item: 60,
        },
        {
          slot_id: 'layout',
          role: 'Layout tokens',
          required: true,
          max_items: 1,
          max_chars_per_item: 60,
        },
        {
          slot_id: 'tokens',
          role: 'Surface tokens',
          required: false,
          max_items: 4,
          max_chars_per_item: 30,
        },
        {
          slot_id: 'sections',
          role: 'Section order',
          required: true,
          min_items: 3,
          max_items: 7,
          max_chars_per_item: 24,
        },
      ],
    },
    {
      section_id: 'quick-actions',
      category: 'operations',
      summary: 'Quick action rail for deterministic operator actions.',
      purpose: 'Group actionable commands into intent-based bands.',
      layout_key: 'action-rail',
      region_order: ['grouped_actions'],
      slots: [
        {
          slot_id: 'grouped_actions',
          role: 'Action groups',
          required: true,
          min_items: 4,
          max_items: 8,
          max_chars_per_item: 28,
        },
      ],
    },
    {
      section_id: 'scenario-selector',
      category: 'navigation',
      summary: 'Scenario presets with one-tap switching.',
      purpose: 'Compress mode switching into a legible selector.',
      layout_key: 'scenario-grid',
      region_order: ['scenario_cards', 'hotkeys'],
      slots: [
        {
          slot_id: 'scenario_cards',
          role: 'Scenario cards',
          required: true,
          min_items: 3,
          max_items: 7,
          max_chars_per_item: 32,
        },
      ],
    },
    {
      section_id: 'operator-views',
      category: 'navigation',
      summary: 'Focused operator views for mission, runtime, and trace inspection.',
      purpose: 'Expose drill-down views without hiding the control plane.',
      layout_key: 'view-switcher',
      region_order: ['views', 'details'],
      slots: [
        {
          slot_id: 'views',
          role: 'View selector',
          required: true,
          min_items: 3,
          max_items: 8,
          max_chars_per_item: 40,
        },
      ],
    },
    {
      section_id: 'surface-cards',
      category: 'status',
      summary: 'Status cards that route operators to the right control section.',
      purpose: 'Offer a compact summary rail with jump targets.',
      layout_key: 'status-grid',
      region_order: ['cards'],
      slots: [
        {
          slot_id: 'cards',
          role: 'Jump cards',
          required: true,
          min_items: 3,
          max_items: 5,
          max_chars_per_item: 30,
        },
      ],
    },
    {
      section_id: 'mission-cycle',
      category: 'process',
      summary: "A compact explanation of Kyberion's mission lifecycle.",
      purpose: 'Keep the operating loop visible even in the web surface.',
      layout_key: 'process-stack',
      region_order: ['steps'],
      slots: [
        {
          slot_id: 'steps',
          role: 'Lifecycle steps',
          required: true,
          min_items: 4,
          max_items: 5,
          max_chars_per_item: 40,
        },
      ],
    },
  ],
};

export function createChronosWebThemePack(mode: 'dark' | 'light' = 'dark'): WebThemePack {
  if (mode === 'light') {
    return {
      ...DEFAULT_CHRONOS_WEB_THEME_PACK,
      theme: {
        ...DEFAULT_CHRONOS_WEB_THEME_PACK.theme,
        name: 'Chronos Bright Command',
        colors: {
          primary: '#0f172a',
          secondary: '#334155',
          accent: '#0057b8',
          background: '#f8fafc',
          text: '#0f172a',
        },
      },
    };
  }

  return DEFAULT_CHRONOS_WEB_THEME_PACK;
}

export function createChronosWebDesignSystem(
  mode: 'dark' | 'light' = 'dark'
): ResolvedWebDesignSystem {
  return composeWebDesignSystem(
    createChronosWebThemePack(mode),
    DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK
  );
}
