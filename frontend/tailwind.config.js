/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}', './public/index.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'ui-sans-serif', 'system-ui'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        app: '#121212',
        container: '#1E1E1E',
        containerHover: '#262626',
        elevated: '#2D2D2D',
        subtle: '#262626',
        accent: '#3B82F6',
        accentHover: '#2563EB',
        sev: {
          minor: '#FBBF24',
          moderate: '#F97316',
          severe: '#EF4444',
          extreme: '#991B1B',
        },
        mag: {
          low: '#94A3B8',
          mid: '#FACC15',
          high: '#F97316',
          critical: '#DC2626',
        },
      },
      animation: {
        fadein: 'fadein .3s ease-out',
        slideup: 'slideup .3s ease-out',
        spinSlow: 'spin 1.4s linear infinite',
      },
      keyframes: {
        fadein: { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        slideup: {
          '0%': { transform: 'translateY(16px)', opacity: 0 },
          '100%': { transform: 'translateY(0)', opacity: 1 },
        },
      },
    },
  },
  plugins: [],
};
