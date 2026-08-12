import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist/desktop-plugins/hermes-crew/plugin.js')

await rm(resolve(root, 'dist'), { recursive: true, force: true })
await mkdir(dirname(output), { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/desktop/plugin.tsx')],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
  legalComments: 'none',
  sourcemap: false,
})
