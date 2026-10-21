import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  define: { __APP_VERSION__: '"test"' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
})
