
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Ensures relative paths for GitHub Pages
  define: {
    // Support the environment variable requirement
    'process.env.API_KEY': JSON.stringify(process.env.API_KEY),
  },
});
