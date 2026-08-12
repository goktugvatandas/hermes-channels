import { readFile, readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const dist = resolve(root, 'dist')
const plugin = await readFile(resolve(dist, 'desktop-plugins/hermes-crew/plugin.js'), 'utf8')
const imports = [
  ...[...plugin.matchAll(/^\s*(?:\}\s*)?from\s+["']([^"']+)["'];?$/gm)].map((match) => match[1]),
  ...[...plugin.matchAll(/^\s*import\s+["']([^"']+)["'];?$/gm)].map((match) => match[1]),
]
const allowed = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
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
  if (!['.js', '.py', '.json', '.yaml', '.yml', '.txt'].includes(extname(path))) continue
  if (secretAssignment.test(await readFile(path, 'utf8'))) throw new Error(`Possible credential assignment in ${path}`)
}
console.log('Hermes Crew distribution verified')
