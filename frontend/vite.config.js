import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  build: {
    outDir: resolve(__dirname, '../backend/public'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['alpinejs'],
          editor: [
            '@tiptap/core', '@tiptap/starter-kit',
            '@tiptap/extension-table',
            '@tiptap/extension-link', '@tiptap/extension-image',
            '@tiptap/extension-placeholder', '@tiptap/extension-mathematics',
            'turndown', 'remark', 'remark-gfm', 'remark-math', 'remark-html',
            'unist-util-visit',
          ],
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
