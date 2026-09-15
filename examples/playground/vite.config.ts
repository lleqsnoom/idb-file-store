import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromHere('.'),
  resolve: {
    alias: {
      // Resolve the package name straight to the TypeScript source so the
      // playground always exercises the working tree.
      'idb-file-store': fromHere('../../src/index.ts'),
    },
  },
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
