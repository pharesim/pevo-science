import { defineConfig } from 'vite';
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';

const vendorModules = ['alpinejs'];
const hiveModules = ['@hiveio/dhive'];
const editorModules = [
  '@tiptap/core', '@tiptap/starter-kit',
  '@tiptap/extension-table',
  '@tiptap/extension-link', '@tiptap/extension-image',
  '@tiptap/extension-placeholder', '@tiptap/extension-mathematics',
  'turndown', 'remark', 'remark-gfm', 'remark-math', 'remark-html',
  'unist-util-visit',
];

export default defineConfig({
  plugins: [tailwindcss()],
  root: '.',
  build: {
    outDir: resolve(__dirname, '../backend/public'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (vendorModules.some((m) => id.includes(`node_modules/${m}`))) return 'vendor';
          if (editorModules.some((m) => id.includes(`node_modules/${m}`))) return 'editor';
          if (hiveModules.some((m) => id.includes(`node_modules/${m}`))) return 'hive';
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  publicDir: 'public',
});
