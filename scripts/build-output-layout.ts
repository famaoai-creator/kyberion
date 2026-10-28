/** Single ownership contract for compiler outputs, cleanup and freshness checks. */
export const PACKAGE_BUILD_OUTPUTS = [
  { id: 'libs/core', sourceRoot: 'libs/core', excludeTests: true },
  { id: 'libs/shared-ui', sourceRoot: 'libs/shared-ui/src', excludeTests: true },
  { id: 'libs/shared-media', sourceRoot: 'libs/shared-media/src', excludeTests: false },
  { id: 'libs/shared-nerve', sourceRoot: 'libs/shared-nerve/src', excludeTests: false },
  { id: 'libs/shared-mobile', sourceRoot: 'libs/shared-mobile/src', excludeTests: false },
  { id: 'libs/shared-network', sourceRoot: 'libs/shared-network/src', excludeTests: false },
  { id: 'libs/shared-vision', sourceRoot: 'libs/shared-vision/src', excludeTests: false },
  {
    id: 'presence/displays/terminal-hud',
    sourceRoot: 'presence/displays/terminal-hud/src',
    excludeTests: true,
  },
] as const;

export const ROOT_SOURCE_EXCLUSIONS = {
  presence: [
    'displays/chronos-mirror-v2',
    'displays/terminal-hud',
    'displays/operator-surface',
    'displays/concierge',
  ],
  scripts: ['clean.ts', 'clean_entrypoint.ts', 'build_repository.ts'],
} as const;

// These are exact historical compiler-owned locations, not a recursive dist search.
export const LEGACY_BUILD_OUTPUTS = [
  'satellites/discord-bridge/dist',
  'satellites/imessage-bridge/dist',
  'satellites/slack-bridge/dist',
  'satellites/telegram-bridge/dist',
  'presence/bridge/terminal/dist',
] as const;

export const OWNED_BUILD_DIRECTORIES = [
  'dist',
  'plugins/dist',
  ...PACKAGE_BUILD_OUTPUTS.map(({ id }) => id + '/dist'),
  ...LEGACY_BUILD_OUTPUTS,
] as const;

export const OWNED_BUILD_METADATA = [
  ...PACKAGE_BUILD_OUTPUTS.map(({ id }) => id + '/tsconfig.tsbuildinfo'),
  ...LEGACY_BUILD_OUTPUTS.map((dir) => dir.replace(/dist$/, 'tsconfig.tsbuildinfo')),
] as const;

export const SOURCE_TREE_ROOTS = ['libs', 'scripts', 'presence', 'satellites', 'plugins'] as const;
export const NON_SOURCE_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  '.git',
  '.worktrees',
  'coverage',
]);

// Handwritten declarations without a sibling .ts/.tsx, generated TypeScript and
// handwritten JS without a TypeScript sibling are source inputs, not shadows.
// Add a reviewed exact-path exception with a reason only for intentional twins.
export const SOURCE_SHADOW_EXCEPTIONS: Readonly<Record<string, string>> = {
  'libs/core/validators.d.cts':
    'Handwritten CommonJS declaration input; validators.ts emits .d.ts, not .d.cts.',
};

export const BUNDLED_SCRIPT_NAMES = [
  'cli',
  'run_pipeline',
  'mission_controller',
  'surface_runtime',
  'chronos_daemon',
] as const;
