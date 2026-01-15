import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Ensures relative paths for assets, critical for GitHub Pages sub-repository hosting
  define: {
    // Injects the environment variable into the build
    'process.env.API_KEY': JSON.stringify(process.env.API_KEY),
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    // Using default minifier (esbuild) to avoid terser dependency issues
  }
});