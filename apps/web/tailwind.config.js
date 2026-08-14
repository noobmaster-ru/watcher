/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["'Manrope Variable'", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
      colors: {
        // Акцент выведен из фиолетового Wildberries в сторону violet-600:
        // он ярче на тёмном фоне и лучше тянет градиент к фуксии.
        wb: { DEFAULT: "#7c3aed", dark: "#6d28d9", light: "#f1e9fe" },
        // Тёмные поверхности подкрашены фиолетовым — чистый slate рядом с
        // акцентными градиентами выглядит чужим. Светлые оттенки не трогаем:
        // это цвета текста, им важнее читаемость, чем тон.
        slate: {
          700: "#3f3a5e",
          800: "#272138",
          900: "#171226",
          950: "#0d0a16",
        },
      },
      boxShadow: {
        // многослойная тень карточек: контактная + цветная рассеянная
        card: "0 1px 2px rgb(23 15 60 / 0.04), 0 12px 32px -16px rgb(109 40 217 / 0.12)",
        glow: "0 4px 20px -4px rgb(124 58 237 / 0.35)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(2px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out",
      },
    },
  },
  plugins: [],
};
