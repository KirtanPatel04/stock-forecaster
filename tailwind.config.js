/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0f1117',
        panel: '#161b22',
        border: '#21262d',
        accent: '#58a6ff',
        green: { 400: '#22c55e', 500: '#16a34a' },
        red: { 400: '#ef4444', 500: '#dc2626' },
        yellow: { 400: '#facc15' },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}
