// make-bootstrap.mjs —— 把整个插件包压成一个自包含的单文件装机脚本。
//
// 动机：用户的核心诉求是「换了电脑 / 换了 DSH / 新加一台机，装上插件就能用」。
// 但插件包是 8 个文件，散着拷容易漏。本脚本把包内容以 base64 内联进
// `dsh-dual-bridge/bootstrap.mjs`，于是新机器上只需要拷一个文件：
//
//   node bootstrap.mjs
//
// 它会：把内联的包内容物化到临时目录 → 体检 → 找 dsh CLI → 缺通道补装 → 装本插件。
//
// 用法：node make-bootstrap.mjs [--pkg <插件目录>] [--out <输出文件>]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, fb) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fb
}

const pkgDir = path.resolve(arg('--pkg', path.join(HERE, '..', 'dsh-dual-bridge')))
const outFile = path.resolve(arg('--out', path.join(pkgDir, 'bootstrap.mjs')))

// 打包进 bootstrap 的文件（相对包目录的路径）。install.mjs 不重复内联——
// bootstrap 自己实现同样的体检/安装逻辑，但复用内联的 install.mjs 作为实现体。
const INCLUDE = [
  'package.json',
  'index.js',
  'cordis.patch.yml',
  'install.mjs',
  'README.md',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
]

function walk(rel) {
  const abs = path.join(pkgDir, rel)
  if (!existsSync(abs)) return null
  const st = statSync(abs)
  if (st.isDirectory()) {
    return readdirSync(abs).flatMap((n) => walk(path.join(rel, n))).filter(Boolean)
  }
  return [rel.replace(/\\/g, '/')]
}

const files = INCLUDE.flatMap((r) => walk(r)).filter(Boolean).sort()
const payload = {}
for (const rel of files) {
  payload[rel] = readFileSync(path.join(pkgDir, rel)).toString('base64')
}

const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const totalBytes = files.reduce((n, rel) => n + statSync(path.join(pkgDir, rel)).size, 0)

const bootstrap = `#!/usr/bin/env node
// dsh-dual-bridge —— 自包含装机脚本（单文件，无需先拷插件目录）。
//
// 用法（新电脑上）：
//   node bootstrap.mjs                     # 物化插件 → 体检 → 找 dsh CLI → 补装通道 → 装插件
//   node bootstrap.mjs --check             # 只体检（不写盘、不安装）
//   node bootstrap.mjs --profile web       # 装进别的 profile
//   node bootstrap.mjs --keep              # 保留物化出来的插件目录（默认也保留，方便改配置）
//   node bootstrap.mjs --dir <目录>        # 指定物化位置（默认 <当前目录>/dsh-dual-bridge）
//
// 本文件由 make-bootstrap.mjs 从插件包生成，版本 ${pkg.version}，内联 ${files.length} 个文件 / ${totalBytes} 字节。
// 它只做四件事：物化 → 体检 → 缺 ds-harness-remote 就补装 → dsh plugin add 本插件。
// 不写 profile 文件、不改 ds-harness-remote 本体、不碰身份目录。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 内联的插件包内容（base64） ──────────────────────────────────
const PAYLOAD = ${JSON.stringify(payload, null, 2)}

const PKG_VERSION = ${JSON.stringify(pkg.version)}
const TRANSPORT_PKG = 'ds-harness-remote'
const TRANSPORT_VERSION = '0.5.7'

const isWin = process.platform === 'win32'
const argv = process.argv.slice(2)
const arg = (name, fb) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fb
}
const has = (name) => argv.includes(name)

const pkgDir = path.resolve(arg('--dir', path.join(process.cwd(), 'dsh-dual-bridge')))
const profile = arg('--profile', process.env.DSH_PROFILE || 'desktop')
const checkOnly = has('--check')
const withTransport = !has('--no-transport')

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profile)

const log = (s) => console.log(s)
const ok = (s) => console.log('  ✓ ' + s)
const bad = (s) => console.log('  ✗ ' + s)
const warn = (s) => console.log('  ! ' + s)

// ── 1. 物化插件包 ──────────────────────────────────────────────
function materialize() {
  log('【物化插件】' + pkgDir)
  let wrote = 0
  for (const [rel, b64] of Object.entries(PAYLOAD)) {
    const abs = path.join(pkgDir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    const buf = Buffer.from(b64, 'base64')
    writeFileSync(abs, buf)
    wrote++
  }
  ok(\`写入 \${wrote} 个文件\`)
  return true
}

// ── 2. 找 dsh CLI ──────────────────────────────────────────────
function findDshCli() {
  const probe = spawnSync(isWin ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const first = String(probe.stdout || '')
      .split(/\\r?\\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0]
    if (first && existsSync(first)) return first
  }
  const bases = [
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DSH Desktop', 'host-commands', profile, 'generations'),
    path.join(process.env.APPDATA || '', 'dsh-desktop', 'host-commands', profile, 'generations'),
  ]
  for (const base of bases) {
    if (!base || !existsSync(base)) continue
    let gens = []
    try {
      gens = readdirSyncSafe(base)
    } catch {
      continue
    }
    for (const gen of gens.reverse()) {
      for (const name of ['dsh.cmd', 'dsh.exe', 'dsh']) {
        const p = path.join(gen, 'bin', name)
        if (existsSync(p)) return p
      }
    }
  }
  return null
}
function readdirSyncSafe(base) {
  // 只挑目录，倒序取最新一代
  return readdirSync(base)
    .map((d) => path.join(base, d))
    .filter((d) => statSync(d).isDirectory())
    .sort()
}

// ── 3. 体检 ────────────────────────────────────────────────────
function healthCheck() {
  log('【体检】')
  const result = { profile: false, transport: false, self: false, identity: false }
  if (!existsSync(profileDir)) {
    bad(\`profile 目录不存在：\${profileDir}\`)
    warn('请先打开一次 DSH Desktop（它会建好 profile），再跑本脚本。')
    return result
  }
  ok(\`profile 目录：\${profileDir}\`)
  result.profile = true

  const remoteDir = path.join(profileDir, 'node_modules', 'ds-harness-remote')
  const remoteEntry = path.join(remoteDir, 'dist', 'index.js')
  if (existsSync(remoteEntry)) {
    ok(\`通道插件 ds-harness-remote 已装：\${remoteDir}\`)
    result.transport = true
  } else {
    bad('通道插件 ds-harness-remote 没装 —— 本插件依赖它提供跨机通道与身份。')
    warn(\`装它：dsh plugin --profile \${profile} add ds-harness-remote\`)
  }

  const selfDir = path.join(profileDir, 'node_modules', 'dsh-dual-bridge')
  if (existsSync(selfDir)) {
    ok('dsh-dual-bridge 已挂进 profile')
    result.self = true
  } else warn('dsh-dual-bridge 还没挂进 profile（本脚本接下来会装）')

  const serversRoot = path.join(dshHome, 'remote', 'servers')
  let identity = null
  if (existsSync(serversRoot)) {
    for (const hash of readdirSync(serversRoot)) {
      const dev = path.join(serversRoot, hash, 'client', 'device.json')
      if (existsSync(dev)) identity = dev
    }
  }
  if (identity) {
    ok(\`本机 client 身份已存在：\${identity}\`)
    result.identity = true
  } else {
    warn('本机还没有 client 身份。装完插件后，在 DSH 的 Remote 面板用 DeepSeek 账号登录一次即可生成。')
    warn('两台机必须用同一个 DeepSeek 账号登录同一个 relay（默认 https://dsh.r2049.cn），才会互相配对。')
  }
  return result
}

// ── 4. 安装 ────────────────────────────────────────────────────
// 注意：dsh CLI 与插件目录都可能含空格（\`DSH Desktop\`、\`DeepSeek Harness\`），
// Windows 下 \`shell: true\` 不会替我们给 argv 加引号，必须自己拼带引号的命令行。
function quoteWin(s) {
  return \`"\${String(s).replace(/"/g, '""')}"\`
}

function runAdd(cli, what, cwd) {
  const args = ['plugin', '--profile', profile, 'add', what]
  const r = isWin
    ? spawnSync([quoteWin(cli), ...args.map(quoteWin)].join(' '), { stdio: 'inherit', shell: true, cwd })
    : spawnSync(cli, args, { stdio: 'inherit', cwd })
  return r.status === 0
}

function installTransport(cli) {
  const remoteEntry = path.join(profileDir, 'node_modules', TRANSPORT_PKG, 'dist', 'index.js')
  if (existsSync(remoteEntry)) {
    ok(\`通道插件 \${TRANSPORT_PKG} 已在位，跳过\`)
    return true
  }
  if (!withTransport) {
    warn(\`--no-transport：不自动补装 \${TRANSPORT_PKG}。请自行安装后再用本插件。\`)
    return false
  }
  log(\`\\n【补装通道】\${TRANSPORT_PKG}@\${TRANSPORT_VERSION}\`)
  if (!runAdd(cli, \`\${TRANSPORT_PKG}@\${TRANSPORT_VERSION}\`, profileDir)) {
    bad(\`补装 \${TRANSPORT_PKG} 失败\`)
    warn(\`可手工重试：dsh plugin --profile \${profile} add \${TRANSPORT_PKG}@\${TRANSPORT_VERSION}\`)
    return false
  }
  ok(\`通道插件 \${TRANSPORT_PKG} 已装\`)
  return true
}

function install(cli) {
  log(\`\\n【安装本插件】\${pkgDir}\`)
  log(\`  dsh CLI : \${cli}\`)
  if (!runAdd(cli, pkgDir, pkgDir)) {
    bad('安装命令非零退出')
    warn('若报占用错误，请完全退出 DSH Desktop 后重试（它独占 profile）。')
    return false
  }
  ok('安装命令完成')
  return true
}

// ── 主流程 ─────────────────────────────────────────────────────
log('dsh-dual-bridge 自包含装机助手')
log(\`  插件版本 : \${PKG_VERSION}\`)
log(\`  物化到   : \${pkgDir}\`)
log(\`  profile  : \${profile}\`)
log(\`  DSH_HOME : \${dshHome}\`)

if (!checkOnly) materialize()
else log('（--check：只体检，不物化、不安装）')

const health = healthCheck()
const cli = findDshCli()

if (checkOnly) {
  log('\\n【dsh CLI】' + (cli ? ' ' + cli : ' 没找到'))
  const okAll = health.profile && health.transport && health.identity && Boolean(cli)
  log('\\n【体检结论】' + (okAll ? '正常，可以装/已可直用' : '有缺项（见上面 ✗ / !）'))
  log('  profile / 通道 / 身份 / dsh CLI 四项：' + [health.profile, health.transport, health.identity, Boolean(cli)].map((v) => (v ? 'OK' : '缺')).join(' / '))
  process.exit(okAll ? 0 : 2)
}

if (!cli) {
  bad('找不到 dsh CLI。')
  warn('请先打开一次 DSH Desktop 生成它，或把 dsh 加进 PATH，然后重跑本脚本。')
  process.exit(2)
}

if (!installTransport(cli)) {
  warn('通道插件没装成 —— 本插件装了也用不了 dual_* 工具。请先解决通道再重跑本脚本。')
  process.exit(1)
}
if (!install(cli)) process.exit(1)

log('\\n【接下来三步】')
log('  1. 让 Agent 调 dual_status 自检（首次安装即热加载，通常不用重启）。')
log('  2. 在 DSH 的 Remote 面板用 DeepSeek 账号登录同一个 relay（两台机同一账号）。')
log('  3. dual_status 应看到本机身份、relay、以及对端设备在线。')
log('')
log('  默认零配置即可用：会取第一个在线对端 + 对端最近更新的工作区 + 新建会话，')
log('  对端 UI 侧栏实时可见。想固定成老习惯（复用同一会话）就在 profile 的')
log('  cordis.patch.yml 里给 dual-bridge 配 defaultPeer / defaultWorkspace / defaultSession。')
log('')
log('  物化出来的插件目录（' + pkgDir + '）可以留着：改 index.js 后要生效，')
log('  需完全退出 DSH Desktop 再打开（运行中的 Host 不会重新加载已装插件的新代码）。')
`

writeFileSync(outFile, bootstrap)
const outSize = statSync(outFile).size
console.log(`bootstrap 已生成：${outFile}`)
console.log(`  内联文件 ${files.length} 个 / ${totalBytes} 字节 → 输出 ${outSize} 字节`)
for (const rel of files) console.log('    - ' + rel)
