import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const excludePythonBytecode = (path) => !path.includes('__pycache__') && !path.endsWith('.pyc')
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const releaseName = `hermes-channels-${version}`
const stage = resolve(root, `dist/release/${releaseName}`)
const archive = resolve(root, `dist/release/${releaseName}.tar.gz`)
await rm(resolve(root, 'dist/release'), { recursive: true, force: true })
await mkdir(stage, { recursive: true })
for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE', 'package.json', 'pyproject.toml']) {
  await copyFile(resolve(root, name), resolve(stage, name))
}
await mkdir(resolve(stage, 'scripts'), { recursive: true })
await copyFile(resolve(root, 'scripts/install.py'), resolve(stage, 'scripts/install.py'))
await mkdir(resolve(stage, 'src/backend'), { recursive: true })
await cp(
  resolve(root, 'src/backend/hermes_channels_backend'),
  resolve(stage, 'src/backend/hermes_channels_backend'),
  { recursive: true, filter: excludePythonBytecode },
)
await cp(resolve(root, 'dist/desktop-plugins'), resolve(stage, 'desktop-plugins'), { recursive: true })
await cp(resolve(root, 'dist/plugins'), resolve(stage, 'plugins'), { recursive: true })
await cp(resolve(root, 'dist/skills'), resolve(stage, 'skills'), { recursive: true })

async function collect(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await collect(path))
    else result.push(path)
  }
  return result.sort()
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function tarPath(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' }
  for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) {
    const prefix = name.slice(0, index)
    const suffix = name.slice(index + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix }
    }
  }
  throw new Error(`Archive path is too long for ustar: ${name}`)
}

function header(path, size) {
  const { name, prefix } = tarPath(path)
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write(octal(0o644, 8), 100, 8, 'ascii')
  block.write(octal(0, 8), 108, 8, 'ascii')
  block.write(octal(0, 8), 116, 8, 'ascii')
  block.write(octal(size, 12), 124, 12, 'ascii')
  block.write(octal(0, 12), 136, 12, 'ascii')
  block.fill(0x20, 148, 156)
  block.write('0', 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write(prefix, 345, 155, 'utf8')
  const checksum = block.reduce((sum, byte) => sum + byte, 0)
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

const chunks = []
for (const path of await collect(stage)) {
  const content = await readFile(path)
  const name = `${releaseName}/${relative(stage, path)}`
  chunks.push(header(name, content.length), content)
  const padding = (512 - (content.length % 512)) % 512
  if (padding) chunks.push(Buffer.alloc(padding))
}
chunks.push(Buffer.alloc(1024))
await writeFile(archive, gzipSync(Buffer.concat(chunks), { mtime: 0 }))
const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(`${archive}.sha256`, `${digest}  ${releaseName}.tar.gz\n`)
console.log(archive)
