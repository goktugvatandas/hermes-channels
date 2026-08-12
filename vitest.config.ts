import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/desktop/**/*.test.ts', 'tests/desktop/**/*.test.tsx'],
    restoreMocks: true,
  },
})
