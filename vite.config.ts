import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1500 }, // three.js alone is ~700 kB
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
