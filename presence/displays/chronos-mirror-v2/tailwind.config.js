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
          gold: "#D4AF37",
          dark: "#0F0F0F",
          accent: "#1A1A1A",
        }
      },
    },
  },
  plugins: [],
}
