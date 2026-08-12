import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@hermes/plugin-sdk': fileURLToPath(
        new URL('./tests/desktop/hermes-sdk-mock.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/desktop/**/*.test.ts', 'tests/desktop/**/*.test.tsx'],
    restoreMocks: true,
  },
})
