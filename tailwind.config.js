/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './public/**/*.{html,js}',
    './private_views/**/*.{html,js}'
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif']
      },
      borderRadius: {
        '2xl': '16px',
        'full': '9999px'
      },
      colors: {
        signature: {
          light: {
            bgFrom: '#fafafa',
            bgTo: '#f6f6f6',
            card: '#fdfdfd',
            text: '#121212',
            profit: '#357941',
            loss: '#b3261e',
            badgeProfit: '#e8f2eb',
            badgeLoss: '#fbe7e5',
            border: '#e5e7eb'
          },
          dark: {
            bgFrom: '#121213',
            bgTo: '#0d0d0e',
            card: '#1a1a1c',
            text: '#f4f4f5',
            profit: '#86c09c',
            loss: '#f08a7e',
            badgeProfit: '#163321',
            badgeLoss: '#3b1816',
            border: '#ffffff0f'
          },
          chart: [
            '#4f6b92',
            '#b89a4c',
            '#8e7cb3',
            '#7b96c9',
            '#b74583',
            '#2f4f73',
            '#d2b98a',
            '#9c998e',
            '#cfccc6'
          ]
        }
      },
      boxShadow: {
        'signature-card': '0 1px 3px rgba(0,0,0,0.03), 0 6px 16px rgba(0,0,0,0.02)',
        'signature-card-hover': '0 4px 12px rgba(0,0,0,0.05), 0 12px 28px rgba(0,0,0,0.04)',
        'signature-dark-card': '0 2px 6px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.25)'
      }
    }
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries')
  ]
};

