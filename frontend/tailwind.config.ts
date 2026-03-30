import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // PEvO brand palette — derived from pevo_design assets
        pevo: {
          green: "#8BA83E",       // Primary olive green from logo
          "green-dark": "#6B8A2E", // Darker shade for hover
          "green-light": "#EDF3DB", // Light tint for backgrounds
          teal: "#1B7A6D",        // Teal from geometric triangles
          "teal-dark": "#14605A",
          "teal-light": "#E0F0EE",
          crimson: "#B31B4B",     // Crimson/magenta from triangles
          "crimson-dark": "#8E1A3C",
          "crimson-light": "#F8E4EB",
        },
        ink: {
          DEFAULT: "#2D2D2D",     // Near-black from logo text
          light: "#4A4A4A",
          muted: "#6B7280",
        },
        parchment: {
          DEFAULT: "#FAFAF8",
          warm: "#F2F0EB",
          dark: "#E0DDD5",
        },
        // Map semantic tokens to brand colors
        accent: {
          DEFAULT: "#1B7A6D",     // Teal as primary accent
          hover: "#14605A",
          light: "#E0F0EE",
        },
        success: "#8BA83E",       // PEvO green for success states
        warning: "#B31B4B",       // Crimson for warnings
      },
      fontFamily: {
        serif: [
          "Merriweather",
          "Georgia",
          "Cambria",
          "Times New Roman",
          "Times",
          "serif",
        ],
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        "paper-title": ["1.75rem", { lineHeight: "2.25rem", fontWeight: "700" }],
        "section-title": ["1.25rem", { lineHeight: "1.75rem", fontWeight: "600" }],
      },
      maxWidth: {
        "reading": "72ch",
        "content": "960px",
      },
      spacing: {
        "18": "4.5rem",
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: "72ch",
            color: "#4A4A4A",
            lineHeight: "1.75",
            "h1, h2, h3, h4": {
              color: "#2D2D2D",
              fontFamily: "Merriweather, Georgia, serif",
            },
            h2: {
              fontSize: "1.5rem",
              marginTop: "2em",
              marginBottom: "0.75em",
              fontWeight: "700",
            },
            h3: {
              fontSize: "1.25rem",
              marginTop: "1.75em",
              marginBottom: "0.5em",
              fontWeight: "600",
            },
            h4: {
              fontSize: "1.1rem",
              marginTop: "1.5em",
              marginBottom: "0.5em",
              fontWeight: "600",
            },
            a: {
              color: "#1B7A6D",
              textDecoration: "underline",
              "&:hover": {
                color: "#14605A",
              },
            },
            blockquote: {
              borderLeftColor: "rgba(27, 122, 109, 0.4)",
              color: "#6B7280",
              fontStyle: "italic",
            },
            code: {
              color: "#2D2D2D",
              backgroundColor: "#F2F0EB",
              borderRadius: "0.25rem",
              padding: "0.15em 0.35em",
              fontWeight: "400",
            },
            "code::before": { content: '""' },
            "code::after": { content: '""' },
            "pre code": {
              backgroundColor: "transparent",
              padding: "0",
            },
            pre: {
              backgroundColor: "#F2F0EB",
              color: "#2D2D2D",
              borderRadius: "0.5rem",
              border: "1px solid #E0DDD5",
            },
            "thead th": {
              color: "#2D2D2D",
              fontWeight: "600",
              borderBottomColor: "#E0DDD5",
            },
            "tbody td": {
              borderBottomColor: "#E0DDD5",
            },
            hr: {
              borderColor: "#E0DDD5",
            },
            strong: {
              color: "#2D2D2D",
            },
          },
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
export default config;
