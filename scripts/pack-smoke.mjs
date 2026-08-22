import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('npm_execpath is unavailable; run this check with npm run pack:smoke')

function runNpm(args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd,
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolveRun({ stdout, stderr })
      else reject(new Error(`npm ${args[0]} failed with exit code ${code}\n${stdout}${stderr}`))
    })
  })
}

function runCommand(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolveRun({ stdout, stderr })
      : reject(new Error(`${command} failed with exit code ${code}\n${stdout}${stderr}`)))
  })
}

async function linkLocalDependency(temporaryRoot, name) {
  const segments = name.split('/')
  const source = join(projectRoot, 'node_modules', ...segments)
  await access(source)
  const target = join(temporaryRoot, 'node_modules', ...segments)
  await mkdir(dirname(target), { recursive: true })
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

async function installFromLocalDependencies(temporaryRoot, tarball) {
  const unpacked = join(temporaryRoot, 'unpacked')
  const installed = join(temporaryRoot, 'node_modules', 'dsh-hermes-bot')
  await mkdir(unpacked, { recursive: true })
  await mkdir(dirname(installed), { recursive: true })
  await runCommand('tar', ['-xzf', tarball, '-C', unpacked], temporaryRoot)
  await rename(join(unpacked, 'package'), installed)
  const sourcePackage = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  const dependencyNames = new Set([
    ...Object.keys(sourcePackage.dependencies ?? {}),
    ...Object.keys(sourcePackage.peerDependencies ?? {}),
    ...Object.keys(sourcePackage.optionalDependencies ?? {}),
  ])
  for (const name of dependencyNames) await linkLocalDependency(temporaryRoot, name)
}

async function assertMissing(path) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`unexpected development-only path in installed package: ${path}`)
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-hermes-bot-pack-smoke-'))
const resolvedTemp = resolve(temporaryRoot)
const expectedPrefix = `${resolve(tmpdir())}${sep}`.toLowerCase()
if (!resolvedTemp.toLowerCase().startsWith(expectedPrefix) || !basename(resolvedTemp).startsWith('dsh-hermes-bot-pack-smoke-')) {
  throw new Error(`refusing to use unexpected temporary directory: ${resolvedTemp}`)
}

try {
  const prebuiltTarball = process.env.DEEPSEEK_BOT_PACK_SMOKE_TARBALL
  let tarballName
  let tarball
  if (prebuiltTarball !== undefined) {
    const sourceTarball = resolve(prebuiltTarball)
    tarballName = basename(sourceTarball)
    if (!sourceTarball.toLowerCase().startsWith(expectedPrefix) || !tarballName.endsWith('.tgz')) {
      throw new Error(`refusing to use unexpected prebuilt tarball: ${sourceTarball}`)
    }
    await access(sourceTarball)
    tarball = join(temporaryRoot, tarballName)
    await copyFile(sourceTarball, tarball)
  } else {
    const packed = await runNpm([
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      temporaryRoot,
    ], projectRoot)
    const packReport = JSON.parse(packed.stdout)
    tarballName = packReport[0]?.filename
    if (typeof tarballName !== 'string' || tarballName.length === 0) throw new Error('npm pack did not report a tarball filename')
    tarball = join(temporaryRoot, tarballName)
  }
  await writeFile(join(temporaryRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n', 'utf8')
  await writeFile(join(temporaryRoot, 'smoke.mjs'), [
    "const root = await import('dsh-hermes-bot')",
    "if (typeof root.BotGateway !== 'function') throw new Error('BotGateway export is unavailable')",
    "let clientRegistration",
    "globalThis.window = { __ModuleLoader__: { load(value) { clientRegistration = value } } }",
    "await import('dsh-hermes-bot/client')",
    "if (clientRegistration?.id !== 'dsh-hermes-bot') throw new Error('client bundle did not register its package id')",
    "if (typeof clientRegistration?.factory !== 'function') throw new Error('client bundle factory is unavailable')",
    "console.log('package imports: ok')",
    '',
  ].join('\n'), 'utf8')
  if (process.env.DEEPSEEK_BOT_PACK_SMOKE_LOCAL_DEPS === 'true') {
    // Restricted development sandboxes may forbid every npm install process,
    // even in offline mode. This explicit fallback still imports the packed
    // tarball while resolving dependencies from the current npm ci tree.
    // CI keeps using the default real npm-install path.
    await installFromLocalDependencies(temporaryRoot, tarball)
  } else {
    await runNpm([
      'install',
      tarball,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ], temporaryRoot)
  }
  const smoke = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(temporaryRoot, 'smoke.mjs')], {
      cwd: temporaryRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolveRun(stdout)
      : reject(new Error(`installed package import failed with exit code ${code}\n${stdout}${stderr}`)))
  })
  const installed = join(temporaryRoot, 'node_modules', 'dsh-hermes-bot')
  const packageJson = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  if (packageJson.name !== 'dsh-hermes-bot') throw new Error('installed package name mismatch')
  await assertMissing(join(installed, 'src'))
  await assertMissing(join(installed, 'test'))
  process.stdout.write(`${smoke.trim()}\ntarball install: ok (${tarballName})\n`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
