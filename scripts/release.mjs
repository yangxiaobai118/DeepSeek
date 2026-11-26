/**
 * Build the installable npm tarball for the GitHub integration bundle.
 *
 * Run with `npm run pack:release`. The tarball follows the manifest's `files`
 * list; this script checks the source runtime files, packs with inherited
 * output (so it also works in sandboxed terminals), and writes a SHA-256
 * checksum beside the tarball for the GitHub Release.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const outputDir = path.join(root, 'dist')
await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })

const required = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'locale/en.json',
  'locale/zh.json',
  'scripts/release.mjs',
]
for (const file of required) {
  try {
    const info = await stat(path.join(root, file))
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    throw new Error(`Missing runtime file: ${file}`)
  }
}

const npmCli = process.env.npm_execpath
const command = npmCli === undefined
  ? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  : process.execPath
const args = [
  ...(npmCli === undefined ? [] : [npmCli]),
  'pack',
  '--pack-destination',
  outputDir,
]
const result = spawnSync(command, args, {
  cwd: root,
  stdio: 'inherit',
  shell: npmCli === undefined && process.platform === 'win32',
})
if (result.status !== 0) {
  throw new Error(`npm pack failed with exit code ${String(result.status)}`)
}

const tarballs = (await readdir(outputDir)).filter((entry) => entry.endsWith('.tgz'))
if (tarballs.length !== 1) {
  throw new Error(`Expected exactly one tarball in ${outputDir}, found ${tarballs.length}`)
}
const filename = tarballs[0]
const tarball = path.join(outputDir, filename)
const size = (await stat(tarball)).size
const digest = createHash('sha256').update(await readFile(tarball)).digest('hex')
await writeFile(path.join(outputDir, 'SHA256SUMS'), `${digest}  ${filename}\n`, 'utf8')

console.log('')
console.log(`Packed ${packageJson.name}@${packageJson.version}`)
console.log(`  tarball: ${tarball}`)
console.log(`  size:    ${size} bytes`)
console.log(`  sha256:  ${digest}`)
console.log('')
console.log('Install on another DSH client:')
console.log(`  dsh plugin --profile <profile> add "${tarball}"`)
