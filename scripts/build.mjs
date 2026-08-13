import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { build } from 'esbuild'
import postcss from 'postcss'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist/desktop-plugins/hermes-crew/plugin.js')
const dashboardOutput = resolve(root, 'dist/plugins/hermes-crew/dashboard/dist/index.js')
const dashboardStyles = resolve(root, 'dist/plugins/hermes-crew/dashboard/dist/style.css')
const run = promisify(execFile)
const excludePythonBytecode = (path) => !path.includes('__pycache__') && !path.endsWith('.pyc')

await rm(resolve(root, 'dist'), { recursive: true, force: true })
await mkdir(dirname(output), { recursive: true })

const scopeSelectors = (scopeClass) => ({
  postcssPlugin: `scope-${scopeClass}`,
  Rule(rule) {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return
    rule.selectors = rule.selectors.map((selector) => (
      selector === ':root' || selector === ':host'
        ? `.${scopeClass}`
        : selector.startsWith(`.${scopeClass}`)
        ? selector
        : `.${scopeClass} ${selector}`
    ))
  },
})

// Hermes Desktop ships no utility classes for plugins, so Crew compiles its
// own scoped stylesheet and inlines it into the desktop bundle.
const desktopStyles = resolve(root, 'dist/desktop-plugins/hermes-crew/style.generated.css')
await run(
  resolve(root, 'node_modules/.bin/tailwindcss'),
  ['-i', resolve(root, 'src/desktop/style.css'), '-o', desktopStyles, '--minify'],
  { cwd: root },
)
const desktopCss = await readFile(desktopStyles, 'utf8')
const scopedDesktopCss = await postcss([scopeSelectors('hermes-crew-desktop')]).process(desktopCss, {
  from: desktopStyles,
  to: desktopStyles,
})
await writeFile(desktopStyles, scopedDesktopCss.css)

await build({
  entryPoints: [resolve(root, 'src/desktop/plugin.tsx')],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
  alias: {
    'virtual:crew-desktop-css': desktopStyles,
  },
  loader: { '.css': 'text' },
  legalComments: 'none',
  sourcemap: false,
})
await rm(desktopStyles, { force: true })

await run(
  resolve(root, 'node_modules/.bin/tailwindcss'),
  ['-i', resolve(root, 'src/dashboard/style.css'), '-o', dashboardStyles, '--minify'],
  { cwd: root },
)

const dashboardCss = await readFile(dashboardStyles, 'utf8')
const scopedDashboardCss = await postcss([scopeSelectors('hermes-crew-dashboard')]).process(dashboardCss, {
  from: dashboardStyles,
  to: dashboardStyles,
})
await writeFile(dashboardStyles, scopedDashboardCss.css)

await cp(resolve(root, 'plugin'), resolve(root, 'dist/plugins/hermes-crew'), {
  recursive: true,
  filter: excludePythonBytecode,
})
await cp(resolve(root, 'skills'), resolve(root, 'dist/skills'), { recursive: true })
await cp(
  resolve(root, 'src/backend/hermes_crew_backend'),
  resolve(root, 'dist/plugins/hermes-crew/dashboard/hermes_crew_backend'),
  {
    recursive: true,
    filter: excludePythonBytecode,
  },
)

await mkdir(dirname(dashboardOutput), { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/dashboard/plugin.tsx')],
  outfile: dashboardOutput,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  alias: {
    '@hermes/plugin-sdk': resolve(root, 'src/dashboard/plugin-sdk-shim.ts'),
    react: resolve(root, 'src/dashboard/react-shim.ts'),
    'react-dom': resolve(root, 'src/dashboard/react-dom-shim.ts'),
    'react/jsx-runtime': resolve(root, 'src/dashboard/react-jsx-runtime-shim.ts'),
  },
  legalComments: 'none',
  sourcemap: false,
})
