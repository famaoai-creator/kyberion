const path = require('node:path');

/**
 * Concierge CSS pipeline. Tailwind serves only the operations console
 * (`/ops`, the former Chronos surface; see tailwind.config.cjs `content`),
 * and its output is scoped to the console frame by `postcss/ops-scope.cjs`.
 * A custom config replaces Next's default plugins, so the defaults
 * (flexbugs fixes + preset-env, same options) are listed explicitly to keep
 * every other Concierge stylesheet compiling exactly as before.
 */
module.exports = {
  plugins: [
    ['tailwindcss', { config: path.join(__dirname, 'tailwind.config.cjs') }],
    './postcss/ops-scope.cjs',
    'next/dist/compiled/postcss-flexbugs-fixes',
    [
      'next/dist/compiled/postcss-preset-env',
      {
        browsers: ['defaults'],
        autoprefixer: { flexbox: 'no-2009' },
        stage: 3,
        features: { 'custom-properties': false },
      },
    ],
  ],
};
