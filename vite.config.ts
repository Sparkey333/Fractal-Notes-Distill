import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  // Always a string literal so `process.env.API_KEY` never leaks into the
  // browser unreplaced; an empty value switches the app to offline distillation.
  const apiKey = JSON.stringify(env.GEMINI_API_KEY ?? '');
  return {
    plugins: [react()],
    server: { port: 3000, host: '0.0.0.0' },
    define: {
      'process.env.API_KEY': apiKey,
      'process.env.GEMINI_API_KEY': apiKey,
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('.', import.meta.url)),
      },
    },
  };
});
