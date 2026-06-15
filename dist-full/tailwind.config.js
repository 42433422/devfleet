/** @type {import('tailwindcss').Config} */

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
    },
    extend: {
      colors: {
        brand: "#22C55E",
        "bg-primary": "#0A0A0B",
        "bg-card": "#1F1F23",
        "text-muted": "#71717A",
      },
    },
  },
  plugins: [],
};
