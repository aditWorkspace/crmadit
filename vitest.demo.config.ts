// Separate config for the cold-email end-to-end demo harness. NOT picked up
// by the normal `vitest run` (which only includes src/**/*.test.ts). Run with:
//   set -a; . ./.env.local; set +a; export FIRECRAWL_API_KEY=...; \
//   npx vitest run --config vitest.demo.config.ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.demo.ts'],
    testTimeout: 1_200_000,
    hookTimeout: 1_200_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
