/**
 * Tailwind for the operations console only (`/ops`, the former Chronos
 * surface, which is written in Tailwind utilities). Content is limited to the
 * console sources and the output is scoped to `.kb-ops` by
 * postcss/ops-scope.cjs; the rest of Concierge uses the shared kb-* contract.
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: {
    relative: true,
    files: [
      './src/app/ops/**/*.{ts,tsx}',
      './src/components/ops/**/*.{ts,tsx}',
      './src/lib/ops/**/*.{ts,tsx}',
    ],
  },
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        kyberion: {
          bg_main: "var(--kb-bg-main)",
          panel_bg: "var(--kb-panel-bg)",
          primary: "var(--kb-primary)",
          secondary: "var(--kb-secondary)",
          accent: "var(--kb-accent)",
          accent_on: "var(--kb-accent-on)",
          warning: "var(--kb-warning)",
          text_primary: "var(--kb-text-primary)",
          text_secondary: "var(--kb-text-secondary)",
          accent_text: "var(--kb-accent-text)",
          surface: "var(--kb-surface)",
          muted_text: "var(--kb-muted-text)",
          border: "var(--kb-border)",
          success: "var(--kb-success)",
          danger: "var(--kb-danger)",
        },
      },
    },
  },
  plugins: [],
};
