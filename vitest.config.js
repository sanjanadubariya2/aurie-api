import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    // One shared test database — run files one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
})
