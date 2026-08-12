/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // фирменный фиолетовый Wildberries — им подсвечиваем действия
        wb: { DEFAULT: "#7b32c9", dark: "#5d2499", light: "#f3e9ff" },
      },
    },
  },
  plugins: [],
};
