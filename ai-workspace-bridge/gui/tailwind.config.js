/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        editor: {
          bg: 'var(--vscode-editor-background)',
          fg: 'var(--vscode-editor-foreground)',
        },
        input: {
          bg: 'var(--vscode-input-background)',
          fg: 'var(--vscode-input-foreground, var(--vscode-editor-foreground))',
          border: 'var(--vscode-input-border, transparent)',
        },
        button: {
          bg: 'var(--vscode-button-background)',
          fg: 'var(--vscode-button-foreground)',
          hover: 'var(--vscode-button-hoverBackground)',
        },
        focus: 'var(--vscode-focusBorder)',
        scrollbar: {
          slider: 'var(--vscode-scrollbarSlider-background)',
          hover: 'var(--vscode-scrollbarSlider-hoverBackground)',
          active: 'var(--vscode-scrollbarSlider-activeBackground)',
        }
      },
      fontFamily: {
        vscode: ['var(--vscode-editor-font-family)', 'sans-serif'],
      },
      fontSize: {
        vscode: ['var(--vscode-editor-font-size)', '1.5'],
      }
    },
  },
  plugins: [],
}
