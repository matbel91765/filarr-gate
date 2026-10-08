import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: '/admin/',
  plugins: [preact()],
  build: {
    outDir: fileURLToPath(new URL('../dist/ui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5178,
    // `npm run dev:ui` : l'API d'administration d'une boîte noire en marche
    proxy: { '/admin/api': 'http://127.0.0.1:8787' },
  },
});
