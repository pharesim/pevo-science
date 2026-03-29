import createNextIntlPlugin from "next-intl/plugin";
import { withSentryConfig } from "@sentry/nextjs";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Build Content-Security-Policy header value.
// Keep this as restrictive as possible while allowing all PEvO functionality.
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
// Allow both http and https for the API URL in CSP
const apiHost = apiUrl.replace(/^https?:\/\//, '');
const apiCspOrigins = `http://${apiHost} https://${apiHost}`;

// Extract IPFS gateway host for CSP (defaults to gateway.pinata.cloud)
const ipfsGateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs/";
const ipfsGatewayOrigin = new URL(ipfsGateway).origin;

const cspDirectives = [
  // Only allow scripts from our own origin (no external JS).
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
  // Tailwind injects inline styles; KaTeX CSS is bundled from node_modules ('self').
  // Google Fonts stylesheet is loaded via @import in globals.css.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // Google Fonts serves font files from gstatic.
  "font-src 'self' https://fonts.gstatic.com",
  // Images: self, data URIs (inline/base64), blob (editor), IPFS gateway, Hive image proxy.
  `img-src 'self' data: blob: ${ipfsGatewayOrigin} https://images.hive.blog`,
  // API calls to backend, IPFS gateways for PDF fetch, and Hive API nodes.
  `connect-src 'self' ${apiCspOrigins} ${ipfsGatewayOrigin} https://api.hive.blog https://api.openhive.network`,
  // Frames: PDF viewer may need 'self' for embedded blob/object URLs; block everything else.
  "frame-src 'self' blob:",
  // Disallow plugins (Flash, Java, etc.).
  "object-src 'none'",
  // Restrict base URI to prevent base-tag hijacking.
  "base-uri 'self'",
  // Only allow form submissions to our own origin.
  "form-action 'self'",
  // Block all <frame>/<iframe> embedding of this site (mirrors X-Frame-Options: DENY).
  "frame-ancestors 'none'",
];

const cspValue = cspDirectives.join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Speed up "Collecting build traces" by excluding heavy / unused packages
  outputFileTracingExcludes: {
    '*': [
      '@swc/core',
      'esbuild',
      '@esbuild/**',
      'playwright',
      '@playwright/**',
      'sharp',
    ],
  },
  // Derive NEXT_PUBLIC_APP_TAG/VERSION from APP_TAG/VERSION so .env only
  // needs one pair of values. NEXT_PUBLIC_* still wins if set explicitly.
  env: {
    NEXT_PUBLIC_APP_TAG: process.env.NEXT_PUBLIC_APP_TAG || process.env.APP_TAG || 'pevo',
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || process.env.APP_VERSION || '0.1',
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          { key: "Content-Security-Policy", value: cspValue },
        ],
      },
    ];
  },
};

const baseConfig = withNextIntl(nextConfig);

// Only apply Sentry webpack plugin when a DSN is configured.
// This avoids build failures when Sentry is not set up.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(baseConfig, {
      // Suppress source-map upload logs during build
      silent: true,
    })
  : baseConfig;
