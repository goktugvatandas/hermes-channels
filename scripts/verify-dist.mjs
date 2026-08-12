import { readFile, readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const dist = resolve(root, 'dist')
const plugin = await readFile(resolve(dist, 'desktop-plugins/hermes-crew/plugin.js'), 'utf8')
// Match Hermes Desktop 0.20.0's runtime-loader scanner exactly. Its deliberately
// simple pattern also scans generated string literals, so this protects the
// shipped artifact from false-positive imports as well as real unsupported ones.
const importSpecifierRe = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g
const imports = [...plugin.matchAll(importSpecifierRe())].map((match) => match[3])
const allowed = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime'])
const unexpected = imports.filter((specifier) => !allowed.has(specifier))
if (unexpected.length) throw new Error(`Unexpected runtime imports: ${unexpected.join(', ')}`)
if (/sourceMappingURL|\/home\/|[A-Z]:\\Users\\/.test(plugin)) throw new Error('Bundle contains source-map or absolute-path material')

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else result.push(path)
  }
  return result
}

const secretAssignment = /\b(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|NOUS|API)_?(?:API_)?KEY\s*=\s*["']?[A-Za-z0-9_-]{12,}/i
for (const path of await files(dist)) {
  if (path.includes('__pycache__') || path.endsWith('.pyc')) {
    throw new Error(`Python bytecode leaked into distribution: ${path}`)
  }
  if (!['.js', '.py', '.json', '.yaml', '.yml', '.txt'].includes(extname(path))) continue
  if (secretAssignment.test(await readFile(path, 'utf8'))) throw new Error(`Possible credential assignment in ${path}`)
}
console.log('Hermes Crew distribution verified')
