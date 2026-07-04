/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        kyberion: {
          bg_main: "var(--kb-bg-main)",
          panel_bg: "var(--kb-panel-bg)",
          primary: "var(--kb-primary)",
          secondary: "var(--kb-secondary)",
          accent: "var(--kb-accent)",
          warning: "var(--kb-warning)",
          text_primary: "var(--kb-text-primary)",
          text_secondary: "var(--kb-text-secondary)",
        }
      },
    },
  },
  plugins: [],
}
