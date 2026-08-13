import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stage = resolve(root, 'dist/release/hermes-crew-0.1.0')
const archive = resolve(root, 'dist/release/hermes-crew-0.1.0.tar.gz')
await rm(resolve(root, 'dist/release'), { recursive: true, force: true })
await mkdir(stage, { recursive: true })
for (const name of ['README.md', 'package.json', 'pyproject.toml']) await copyFile(resolve(root, name), resolve(stage, name))
await mkdir(resolve(stage, 'scripts'), { recursive: true })
await copyFile(resolve(root, 'scripts/install.py'), resolve(stage, 'scripts/install.py'))
await cp(resolve(root, 'dist/desktop-plugins'), resolve(stage, 'desktop-plugins'), { recursive: true })
await cp(resolve(root, 'dist/plugins'), resolve(stage, 'plugins'), { recursive: true })

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

function header(name, size) {
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
  const checksum = block.reduce((sum, byte) => sum + byte, 0)
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

const chunks = []
for (const path of await collect(stage)) {
  const content = await readFile(path)
  const name = `hermes-crew-0.1.0/${relative(stage, path)}`
  if (Buffer.byteLength(name) > 100) throw new Error(`Archive path is too long: ${name}`)
  chunks.push(header(name, content.length), content)
  const padding = (512 - (content.length % 512)) % 512
  if (padding) chunks.push(Buffer.alloc(padding))
}
chunks.push(Buffer.alloc(1024))
await writeFile(archive, gzipSync(Buffer.concat(chunks), { mtime: 0 }))
const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(`${archive}.sha256`, `${digest}  hermes-crew-0.1.0.tar.gz\n`)
console.log(archive)
