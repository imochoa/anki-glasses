import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(process.cwd(), 'src/app'),
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), 'src/app/index.html'),
        calibrate: resolve(process.cwd(), 'src/app/calibrate.html'),
      },
    },
    outDir: resolve(process.cwd(), 'dist/app'),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
  },
  server: { host: '0.0.0.0' },
});
