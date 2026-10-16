#!/usr/bin/env node
// dsh-dual-bridge 装机脚本：在一台新电脑上把本插件挂进 DSH profile。
//
// 用法（在解压后的插件目录里跑）：
//   node install.mjs                     # 体检 + 装通道依赖（缺的话）+ 装本插件
//   node install.mjs --profile web       # 装进其它 profile
//   node install.mjs --check             # 只体检，不安装
//   node install.mjs --no-transport      # 不自动补装 ds-harness-remote
//   node install.mjs --dir <插件目录>     # 显式指定插件目录（默认脚本所在目录）
//
// 它只做四件事：体检 → 找 dsh CLI → 缺 ds-harness-remote 就补装 → 跑
// `dsh plugin --profile <p> add <目录>` 装本插件。不写任何 profile 文件、
// 不改 ds-harness-remote 本体、不碰身份目录。

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'
const TRANSPORT_PKG = 'ds-harness-remote'
const TRANSPORT_VERSION = '0.5.7'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(name)

const pkgDir = path.resolve(arg('--dir', HERE))
const profile = arg('--profile', process.env.DSH_PROFILE || 'desktop')
const checkOnly = has('--check')
const withTransport = !has('--no-transport')

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profile)

const log = (s) => console.log(s)
const ok = (s) => console.log('  ✓ ' + s)
const bad = (s) => console.log('  ✗ ' + s)
const warn = (s) => console.log('  ! ' + s)

// ── 1. 找 dsh CLI ──────────────────────────────────────────────
function findDshCli() {
  // a) PATH 上直接有
  const probe = spawnSync(isWin ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const first = String(probe.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0]
    if (first && existsSync(first)) return first
  }
  // b) DSH Desktop 的 host-commands 目录：generations/<hash>/bin/dsh.cmd
  const bases = [
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DSH Desktop', 'host-commands', profile, 'generations'),
    path.join(process.env.APPDATA || '', 'dsh-desktop', 'host-commands', profile, 'generations'),
  ]
  for (const base of bases) {
    if (!base || !existsSync(base)) continue
    let gens = []
    try {
      gens = readdirSync(base)
        .map((d) => path.join(base, d))
        .filter((d) => statSync(d).isDirectory())
        .sort()
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

// ── 2. 体检 ────────────────────────────────────────────────────
function healthCheck() {
  log('【体检】')
  if (!existsSync(profileDir)) {
    bad(`profile 目录不存在：${profileDir}`)
    warn('请先打开一次 DSH Desktop（它会建好 profile），再跑本脚本。')
    return false
  }
  ok(`profile 目录：${profileDir}`)

  const remoteDir = path.join(profileDir, 'node_modules', 'ds-harness-remote')
  const remoteEntry = path.join(remoteDir, 'dist', 'index.js')
  if (existsSync(remoteEntry)) ok(`通道插件 ds-harness-remote 已装：${remoteDir}`)
  else {
    bad('通道插件 ds-harness-remote 没装 —— 本插件依赖它提供跨机通道与身份。')
    warn(`装它：dsh plugin --profile ${profile} add ds-harness-remote`)
  }

  const selfDir = path.join(profileDir, 'node_modules', 'dsh-dual-bridge')
  if (existsSync(selfDir)) ok('dsh-dual-bridge 已挂进 profile')
  else warn('dsh-dual-bridge 还没挂进 profile（本脚本接下来会装）')

  // 身份目录：$DSH_HOME/remote/servers/<serverHash>/client/device.json
  const serversRoot = path.join(dshHome, 'remote', 'servers')
  let identity = null
  if (existsSync(serversRoot)) {
    for (const hash of readdirSync(serversRoot)) {
      const dev = path.join(serversRoot, hash, 'client', 'device.json')
      if (existsSync(dev)) identity = dev
    }
  }
  if (identity) {
    ok(`本机 client 身份已存在：${identity}`)
  } else {
    warn('本机还没有 client 身份。装完插件后，在 DSH 的 Remote 面板用 DeepSeek 账号登录一次即可生成。')
    warn('两台机必须用同一个 DeepSeek 账号登录同一个 relay（默认 https://dsh.r2049.cn），才会互相配对。')
  }
  return true
}

// ── 3. 安装 ────────────────────────────────────────────────────
function runAdd(cli, what, cwd) {
  const args = ['plugin', '--profile', profile, 'add', what]
  const r = spawnSync(cli, args, { stdio: 'inherit', shell: isWin, cwd })
  return r.status === 0
}

function installTransport(cli) {
  const remoteEntry = path.join(profileDir, 'node_modules', TRANSPORT_PKG, 'dist', 'index.js')
  if (existsSync(remoteEntry)) {
    ok(`通道插件 ${TRANSPORT_PKG} 已在位，跳过`)
    return true
  }
  if (!withTransport) {
    warn(`--no-transport：不自动补装 ${TRANSPORT_PKG}。请自行安装后再用本插件。`)
    return false
  }
  log(`\n【补装通道】${TRANSPORT_PKG}@${TRANSPORT_VERSION}`)
  log('  本插件依赖它提供跨机通道与身份；缺它则 dual_* 工具全部不可用。')
  if (!runAdd(cli, `${TRANSPORT_PKG}@${TRANSPORT_VERSION}`, profileDir)) {
    bad(`补装 ${TRANSPORT_PKG} 失败`)
    warn(`可手工重试：dsh plugin --profile ${profile} add ${TRANSPORT_PKG}@${TRANSPORT_VERSION}`)
    return false
  }
  ok(`通道插件 ${TRANSPORT_PKG} 已装`)
  return true
}

function install(cli) {
  log(`\n【安装本插件】${pkgDir}`)
  log(`  dsh CLI : ${cli}`)
  if (!runAdd(cli, pkgDir, pkgDir)) {
    bad('安装命令非零退出')
    warn('若报「DSH 独占闸门」之类的占用错误，请完全退出 DSH Desktop 后重试（它独占 profile）。')
    return false
  }
  ok('安装命令完成')
  log('  ! 注意：命令行安装属于「冷装」——装完 DSH 里可能还跑着旧模块。')
  log('    改完插件代码后要让改动生效，最省事的做法是完全退出 DSH Desktop 再打开一次。')
  return true
}

// ── 主流程 ─────────────────────────────────────────────────────
log('dsh-dual-bridge 装机助手')
log(`  插件目录 : ${pkgDir}`)
log(`  profile  : ${profile}`)
log(`  DSH_HOME : ${dshHome}`)

const healthy = healthCheck()
const cli = findDshCli()

if (checkOnly) {
  log('\n【dsh CLI】' + (cli ? ' ' + cli : ' 没找到'))
  process.exit(healthy && cli ? 0 : 2)
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

log('\n【接下来三步】')
log('  1. 装完先直接试：让 Agent 调 dual_status 自检。')
log('     —— 首次安装是热加载的（实测 install_bundle 返回 application:"applied" 后工具立即可用），')
log('        通常不用重启。若工具没出现，再完全退出 DSH Desktop 重开一次。')
log('  2. 在 DSH 的 Remote 面板用 DeepSeek 账号登录同一个 relay（两台机同一账号）。')
log('  3. dual_status 应看到本机身份、relay、以及对端设备在线。')
log('')
log('  默认零配置即可用：不填 defaultPeer/defaultWorkspace/defaultSession 时，')
log('  会取第一个在线对端 + 对端最近更新的工作区 + 新建会话，对端 UI 侧栏实时可见。')
log('')
log('  想固定成老习惯（复用同一会话）时，在 profile 的 cordis.patch.yml 里给 dual-bridge 配：')
log('    config:')
log('      defaultPeer: <对端名称>')
log('      defaultWorkspace: <工作区标题>')
log('      defaultSession: session-xxxx')
log('  或直接告诉 Agent「用 session-xxxx 发给 <对端>」，每次调用传参即可，不必改配置。')
