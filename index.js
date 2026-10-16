// dsh-dual-bridge —— 把已装的 ds-harness-remote 通道封装成模型可直接调用的工具。
//
// 设计原则（零侵入）：
//   1. 不新建身份、不重新登录：优先复用宿主已 provide 的 dshRemoteClient 运行时；
//      没有时自建一个 ClientModeRuntime，但共用同一份身份目录（$DSH_HOME/remote/servers/<id>/client）。
//   2. 绝不调用 runtime.setMode()。setMode 会走 selectRemoteTarget()，把本机 UI 的
//      sessions/workspace/skills/llm/settings 等 11 个 domain 转发到远端（ApiProxySwitch）。
//      本插件只用 ensureConnected()（缓存连接，不碰任何开关）或 connect()（纯建连，连缓存都不碰）。
//   3. 收发一律走自建的 RemoteTypertGateway，不经过宿主的 gatewaySwitch 转发。
//
// 依赖：只 import 'ds-harness-remote' 与 node 内置模块。不 import 任何 @deepseek-ai/* 包
//（它们在 profile 解析链上不可达；工具注册走 ctx.tools.register + 原生 JSON Schema）。

import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-dual-bridge'
export const inject = ['tools']

// ─────────────────────────── 常量与默认值 ───────────────────────────

const DEFAULT_SERVER_URL = 'https://dsh.r2049.cn'
const DEFAULT_MODEL = 'workbuddy-xdpool-global/deepseek-v4.1-flash'
const DEFAULT_TIMEOUT_MS = 600_000
const FALLBACK_HARNESS_VERSION = '0.2.0-rc.2'
const PLUGIN_DIR = 'ds-harness-remote'
const SILENT = { info() {}, warn() {}, error() {}, debug() {} }

const text = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]
const OUTPUT_STR = { schema: { type: 'string' }, render: (_args, value) => text(value) }

// ─────────────────────────── 配置归一化 ───────────────────────────

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const num = Number(cfg.timeoutMs)
  return {
    serverUrl: typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim() ? cfg.serverUrl.trim().replace(/\/+$/, '') : DEFAULT_SERVER_URL,
    defaultPeer: typeof cfg.defaultPeer === 'string' ? cfg.defaultPeer.trim() : '',
    defaultWorkspace: typeof cfg.defaultWorkspace === 'string' ? cfg.defaultWorkspace.trim() : '',
    defaultSession: typeof cfg.defaultSession === 'string' ? cfg.defaultSession.trim() : '',
    defaultModel: typeof cfg.defaultModel === 'string' && cfg.defaultModel.includes('/') ? cfg.defaultModel.trim() : DEFAULT_MODEL,
    timeoutMs: Number.isFinite(num) && num >= 5000 ? num : DEFAULT_TIMEOUT_MS,
    connectMode: cfg.connectMode === 'connect' ? 'connect' : 'reuse',
    // 没指定 session / workspace 时，是否自动挑对端「最近更新」的工作区建会话。
    // 开着才能保证新会话在对端 UI 侧栏实时可见（游离会话对端看不到）。
    autoWorkspace: cfg.autoWorkspace === false ? false : true,
    // 运行时来源：
    //   auto（默认）—— 优先复用宿主 dshRemoteClient；但会先做一次连接健康探测，
    //                  宿主那条陈旧连接探测失败时自动退回自建运行时。
    //   own        —— 始终自建（共用同一身份目录，不新建身份、不重新登录）。
    //   host       —— 只用宿主运行时。
    runtimeMode: cfg.runtimeMode === 'own' || cfg.runtimeMode === 'host' ? cfg.runtimeMode : 'auto',
    // 连接健康探测的超时（毫秒）。探测只发一个最便宜的只读调用，正常几十毫秒。
    probeTimeoutMs: Number.isFinite(Number(cfg.probeTimeoutMs)) && Number(cfg.probeTimeoutMs) >= 500 ? Number(cfg.probeTimeoutMs) : 4000,
  }
}

// ─────────────────────────── 加载 ds-harness-remote ───────────────────────────

function dshHomeOf() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

function pluginEntryCandidates() {
  const out = []
  const explicit = process.env.DSH_REMOTE_PLUGIN
  if (typeof explicit === 'string' && explicit.trim()) out.push(explicit.trim())
  const home = dshHomeOf()
  const profiles = []
  if (process.env.DSH_PROFILE) profiles.push(process.env.DSH_PROFILE)
  profiles.push('desktop', 'web')
  for (const p of profiles) {
    out.push(path.join(home, 'profiles', p, 'node_modules', PLUGIN_DIR, 'dist', 'index.js'))
  }
  out.push(path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', 'profiles', 'web', 'node_modules', PLUGIN_DIR, 'dist', 'index.js'))
  return [...new Set(out)]
}

let pluginModuleCache = null

async function loadPluginModule() {
  if (pluginModuleCache) return pluginModuleCache
  const attempts = []
  try {
    pluginModuleCache = await import(PLUGIN_DIR)
    return pluginModuleCache
  } catch (err) {
    attempts.push(`bare: ${err?.code || err?.message}`)
  }
  for (const candidate of pluginEntryCandidates()) {
    try {
      pluginModuleCache = await import(pathToFileURL(candidate).href)
      return pluginModuleCache
    } catch (err) {
      attempts.push(`${candidate}: ${err?.code || err?.message}`)
    }
  }
  throw Object.assign(
    new Error(
      '找不到 ds-harness-remote 插件本体，无法建立跨机通道。\n' +
        '请先安装并登录：dsh plugin --profile desktop add ds-harness-remote\n' +
        '尝试过的位置：\n  ' + attempts.join('\n  '),
    ),
    { code: 'BRIDGE_TRANSPORT_MISSING' },
  )
}

// ─────────────────────────── 通道运行时 ───────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeRuntime(mod, serverUrl, harnessVersion) {
  const clientDir = mod.serverStorageDirectory(path.join(dshHomeOf(), 'remote'), serverUrl, 'client')
  const localGatewayStub = {
    invoke: async () => ({ ok: false }),
    dispatchRpc: async () => ({ ok: false }),
    openWireStream: async () => {
      throw new Error('dsh-dual-bridge: local gateway stream is not available')
    },
  }
  const hostStub = {
    localHarnessVersion: () => harnessVersion,
    hasStoredAuthorization: async () => false,
    hostStatus: () => ({ authorized: false }),
    authorizeHostAsOwned: async () => undefined,
  }
  const config = mod.resolveConfig({
    enabled: true,
    role: 'client',
    serverUrl,
    deviceName: os.hostname(),
    hostControl: { enabled: false },
  })
  return new mod.ClientModeRuntime(
    config,
    new mod.IdentityStore({ directory: clientDir }),
    new mod.ClientServerApi(serverUrl, new mod.ServerCredentialStore(clientDir)),
    undefined,
    localGatewayStub,
    SILENT,
    hostStub,
  )
}

class Bridge {
  constructor(ctx, cfg) {
    this.ctx = ctx
    this.cfg = cfg
    this.runtime = null
    this.ownsRuntime = false
    this.mod = null
    this.gateways = new Map() // deviceId -> { gateway, remote }
    this.fallbackReason = ''
  }

  /** 复用宿主运行时；没有才自建（同一身份目录，不新建身份、不重新登录）。 */
  async runtimeOf() {
    if (this.runtime) return this.runtime
    if (this.cfg.runtimeMode !== 'own') {
      const host = typeof this.ctx.get === 'function' ? this.ctx.get('dshRemoteClient', false) : undefined
      if (host && typeof host.devices === 'function') {
        const st = typeof host.status === 'function' ? host.status() : {}
        if (st && st.identityReady) {
          this.runtime = host
          this.ownsRuntime = false
          this.mod = null
          return this.runtime
        }
      }
      if (this.cfg.runtimeMode === 'host') {
        throw Object.assign(new Error('runtimeMode=host，但没有拿到宿主的 dshRemoteClient（身份未就绪或 ds-harness-remote 未加载）。'), {
          code: 'BRIDGE_NO_HOST_RUNTIME',
        })
      }
    }
    await this.spawnOwnRuntime()
    return this.runtime
  }

  /** 自建运行时（共用同一身份目录）。 */
  async spawnOwnRuntime() {
    const mod = await loadPluginModule()
    this.mod = mod
    const runtime = makeRuntime(mod, this.cfg.serverUrl, FALLBACK_HARNESS_VERSION)
    await runtime.start()
    this.runtime = runtime
    this.ownsRuntime = true
    return runtime
  }

  /** 宿主那条连接探测不通时，整体切到自建运行时。 */
  async fallbackToOwn(reason) {
    if (this.ownsRuntime) return
    this.fallbackReason = reason
    this.runtime = null
    this.gateways.clear()
    await this.spawnOwnRuntime()
  }

  /** 选对端：显式名称/deviceId 优先，其次配置默认，再其次第一个在线。 */
  async resolvePeer(want) {
    const runtime = await this.runtimeOf()
    let devices
    try {
      devices = await runtime.devices()
    } catch (err) {
      throw Object.assign(
        new Error(
          '读取对端设备失败：' + (err?.message || err) + '\n' +
            '若提示身份未就绪，请先在 DSH 的 Remote 面板用 DeepSeek 账号登录（两台机必须同一账号）。',
        ),
        { code: err?.code || 'BRIDGE_DEVICE_LIST_FAILED' },
      )
    }
    const others = (devices || []).filter((d) => d && d.name !== os.hostname())
    if (others.length === 0) {
      throw Object.assign(new Error('没有已配对的对端设备。请确认两台机用同一 DeepSeek 账号登录了同一个 relay（' + this.cfg.serverUrl + '）。'), {
        code: 'BRIDGE_NO_PEER',
      })
    }
    const key = want || this.cfg.defaultPeer
    if (!key) {
      const online = others.find((d) => d.online)
      if (!online) {
        throw Object.assign(new Error('对端都离线：' + others.map((d) => d.name).join('、')), { code: 'BRIDGE_PEER_OFFLINE' })
      }
      return { peer: online, devices: others }
    }
    const hit = others.find((d) => d.deviceId === key || d.name === key)
    if (!hit) {
      throw Object.assign(
        new Error('找不到对端「' + key + '」。已知对端：' + others.map((d) => `${d.name}(${d.deviceId.slice(0, 8)}…)`).join('、')),
        { code: 'BRIDGE_PEER_NOT_FOUND' },
      )
    }
    if (!hit.online) {
      throw Object.assign(new Error('对端「' + hit.name + '」当前离线。请确认那台机开着 DSH 且已登录同一账号。'), { code: 'BRIDGE_PEER_OFFLINE' })
    }
    return { peer: hit, devices: others }
  }

  /**
   * 取网关。
   *   reuse（默认）：ensureConnected —— 缓存连接，只写 this.connected，不碰任何 UI 开关。
   *   connect       ：connect —— 纯建连，连 this.connected 都不写。
   * 两者都不会调用 setMode / selectRemoteTarget。
   *
   * 拿连接前先做一次轻量健康探测。原因是宿主的 dshRemoteClient 会把连接缓存在
   * this.connected 里，ensureConnected 见到 deviceId 相同就直接返回，哪怕那条通道
   * 早就断了 —— 之后所有 RPC 都打在死通道上，一路超时。我们无法清理宿主那个私有
   * 字段（也不该动它），所以：探测失败就整体退回自建运行时（同一身份目录，不新建身份）。
   */
  async gatewayFor(deviceId) {
    const runtime = await this.runtimeOf()
    if (this.cfg.connectMode === 'reuse') {
      const cached = this.gateways.get(deviceId)
      if (cached && cached.remote?.client && !cached.remote.client.closed) return cached
    }

    let remote = await this.connectOnce(runtime, deviceId)
    let gateway = this.makeGateway(runtime, remote)

    if (!(await probeGateway(gateway, this.cfg.probeTimeoutMs))) {
      if (!this.ownsRuntime && this.cfg.runtimeMode === 'auto') {
        // 宿主运行时这条路不可靠：整条切到自建运行时，后续调用不再走宿主。
        await this.fallbackToOwn('宿主 dshRemoteClient 的连接不可用（健康探测超时）')
        remote = await this.connectOnce(this.runtime, deviceId, { force: true })
        gateway = this.makeGateway(this.runtime, remote)
        if (!(await probeGateway(gateway, this.cfg.probeTimeoutMs))) {
          throw Object.assign(new Error('连上了对端，但通道发不出请求。请确认对端 DSH 在线，或在 Remote 面板重新登录后重试。'), {
            code: 'BRIDGE_CHANNEL_DEAD',
          })
        }
      } else {
        // 自建运行时：缓存里那条连接坏了，直接断掉重连一次。
        try {
          await remote?.client?.close?.()
        } catch {
          /* ignore */
        }
        this.gateways.delete(deviceId)
        remote = await this.connectOnce(runtime, deviceId, { force: true })
        gateway = this.makeGateway(runtime, remote)
        if (!(await probeGateway(gateway, this.cfg.probeTimeoutMs))) {
          throw Object.assign(new Error('连上了对端，但通道发不出请求。请确认对端 DSH 在线，或在 Remote 面板重新登录后重试。'), {
            code: 'BRIDGE_CHANNEL_DEAD',
          })
        }
      }
    }

    const entry = { gateway, remote }
    this.gateways.set(deviceId, entry)
    return entry
  }

  async connectOnce(runtime, deviceId, { force = false } = {}) {
    if (force) {
      const cached = this.gateways.get(deviceId)
      if (cached?.remote?.client && !cached.remote.client.closed) {
        try {
          await cached.remote.client.close()
        } catch {
          /* ignore */
        }
      }
      return await runtime.connect(deviceId)
    }
    return this.cfg.connectMode === 'connect' ? await runtime.connect(deviceId) : await runtime.ensureConnected(deviceId)
  }

  makeGateway(runtime, remote) {
    return this.mod
      ? new this.mod.RemoteTypertGateway(remote.client, undefined, remote.harnessVersion)
      : runtime.remoteTypertGateway(remote)
  }

  /** 统一调用：兼容 request / _request 两种 wire 形状。 */
  async invoke(gateway, namespace, method, body, signal) {
    try {
      return await gateway.invoke({ namespace, method, args: { request: body ?? {} }, signal })
    } catch (err) {
      const msg = String(err?.message ?? '')
      if (/missing "_request"|unexpected "request"/.test(msg)) {
        return await gateway.invoke({ namespace, method, args: { _request: body ?? {} }, signal })
      }
      if (/unexpected "_request"|missing "request"/.test(msg)) {
        return await gateway.invoke({ namespace, method, args: body ?? {}, signal })
      }
      throw err
    }
  }

  async close() {
    if (this.ownsRuntime && this.runtime) {
      try {
        await this.runtime.close()
      } catch {
        /* 已关或未连，忽略 */
      }
    }
    this.runtime = null
    this.gateways.clear()
  }
}

// ─────────────────────────── 共用流程 ───────────────────────────

/**
 * 轻量健康探测：发一个最便宜的只读调用（session/list）看通道是否真的活着。
 * 只等 ms 毫秒就判死 —— 陈旧连接上的 RPC 要拖到 60s 才超时，不能等它。
 */
async function probeGateway(gateway, ms = 4000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    const r = await Promise.race([
      gateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} }, signal: ac.signal }),
      sleep(ms + 500).then(() => 'BRIDGE_PROBE_TIMEOUT'),
    ])
    return r !== 'BRIDGE_PROBE_TIMEOUT'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function listWorkspaces(bridge, gateway, signal) {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  const timer = setTimeout(() => ac.abort(), 5000)
  try {
    const stream = await gateway.open('workspace/follow', { args: {} }, ac.signal)
    for await (const frame of stream) {
      if (frame?.type === 'baseline') return frame.value?.items ?? []
    }
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

function pickWorkspace(items, want, wantId) {
  if (wantId) {
    const hit = items.find((w) => w.workspaceId === wantId)
    if (!hit) {
      throw Object.assign(new Error('workspaceId 未命中：' + wantId + '\n已知工作区：\n' + items.map((w) => `  ${w.workspaceId}  ${w.title}  ${w.path}`).join('\n')), {
        code: 'BRIDGE_WORKSPACE_NOT_FOUND',
      })
    }
    return hit
  }
  if (!want) return null
  const low = want.toLowerCase()
  return (
    items.find((w) => w.path === want || w.workspaceId === want || w.title === want) ||
    items.find((w) => String(w.path).toLowerCase().includes(low) || String(w.title).toLowerCase().includes(low)) ||
    null
  )
}

async function listSessions(bridge, gateway, signal) {
  const out = await bridge.invoke(gateway, 'session', 'list', {}, signal)
  return out?.items ?? []
}

function sessionSummary(s) {
  const p = s?.projections?.values ?? {}
  return {
    sessionId: s?.sessionId,
    title: p.title ?? '',
    cwd: s?.cwd ?? '',
    updatedAt: s?.updatedAt ?? 0,
    running: !!s?.running,
    blank: !!s?.blank,
  }
}

/** 读一次会话快照（只读，不下发任何东西）。 */
async function readSnapshot(gateway, sessionId, signal, ms = 8000) {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    const stream = await gateway.open(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } },
      ac.signal,
    )
    for await (const frame of stream) {
      if (frame?.type === 'snapshot') return frame
    }
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
}

// ─────────────────────────── 工具定义 ───────────────────────────

function toolDefs(bridge) {
  const cfg = bridge.cfg

  return [
    {
      name: 'dual_status',
      description:
        '查看双向沟通桥的状态：本机身份、relay 地址、已配对的对端设备及其在线情况、当前连接模式与默认配置。排查「发不出去」时先跑这个。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT_STR,
      async execute(_args, exec) {
        const runtime = await bridge.runtimeOf()
        const st = typeof runtime.status === 'function' ? runtime.status() : {}
        const lines = []
        lines.push('【本机】')
        lines.push('  deviceName : ' + (st.deviceName ?? os.hostname()))
        lines.push('  deviceId   : ' + (st.deviceId ?? '(身份未就绪)'))
        lines.push('  serverUrl  : ' + cfg.serverUrl)
        lines.push('  身份来源   : ' + (bridge.ownsRuntime ? '本插件自建（共用同一身份目录）' : '复用宿主 dshRemoteClient'))
        lines.push('  连接状态   : ' + (st.connected ? `已连 ${st.transport}` : '未连接（按需建连）'))
        lines.push('  连接模式   : ' + cfg.connectMode)
        lines.push('')
        lines.push('【默认配置】')
        lines.push('  defaultPeer      : ' + (cfg.defaultPeer || '(未设，取第一个在线)'))
        lines.push('  defaultWorkspace : ' + (cfg.defaultWorkspace || '(未设，取最近更新)'))
        lines.push('  defaultSession   : ' + (cfg.defaultSession || '(未设，按需新建)'))
        lines.push('  defaultModel     : ' + cfg.defaultModel)
        lines.push('  timeoutMs        : ' + cfg.timeoutMs)
        lines.push('  autoWorkspace    : ' + (cfg.autoWorkspace ? '开（新建会话自动挂对端最近更新的工作区，对端 UI 侧栏可见）' : '关（无 defaultSession/Workspace 时建游离会话）'))
        lines.push('')
        try {
          const { devices } = await bridge.resolvePeer(undefined)
          lines.push('【已配对的对端】')
          for (const d of devices) lines.push(`  ${d.online ? '在线' : '离线'}  ${d.name}  ${d.deviceId}`)
        } catch (err) {
          lines.push('【已配对的对端】读取失败：' + (err?.message ?? err))
        }
        return lines.join('\n')
      },
    },

    {
      name: 'dual_peers',
      description: '列出已配对的对端设备（deviceId、名称、是否在线）。跨机发消息前用它确认目标名称。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT_STR,
      async execute(_args, exec) {
        const runtime = await bridge.runtimeOf()
        const devices = await runtime.devices()
        const others = (devices || []).filter((d) => d && d.name !== os.hostname())
        if (others.length === 0) return '没有已配对的对端设备。两台机需用同一 DeepSeek 账号登录同一个 relay（' + cfg.serverUrl + '）。'
        return others
          .map((d) => `${d.online ? '● 在线' : '○ 离线'}  ${d.name}\n    deviceId: ${d.deviceId}`)
          .join('\n')
      },
    },

    {
      name: 'dual_workspaces',
      description: '列出对端机器上的工作区（workspaceId、标题、路径、会话数）。用于选定往哪个工作区投递任务——带 workspaceId 建会话才会在对端 UI 侧栏实时可见。',
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: '对端名称或 deviceId；省略用默认对端' },
        },
        additionalProperties: false,
      },
      output: OUTPUT_STR,
      async execute(args, exec) {
        const { peer } = await bridge.resolvePeer(args?.peer)
        const { gateway } = await bridge.gatewayFor(peer.deviceId)
        const items = await listWorkspaces(bridge, gateway, exec?.signal)
        if (items.length === 0) return `对端「${peer.name}」没有工作区。`
        return (
          `对端「${peer.name}」的工作区（${items.length} 个）：\n` +
          items
            .map((w) => `  ${w.workspaceId}\n    ${w.title}  ←  ${w.path}\n    会话 ${(w.sessionIds ?? []).length} 个`)
            .join('\n')
        )
      },
    },

    {
      name: 'dual_sessions',
      description: '列出对端机器上的会话（可选按工作区过滤）。返回 sessionId、标题、工作目录、更新时间、是否运行中。复用固定会话前用它确认会话 id。',
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: '对端名称或 deviceId；省略用默认对端' },
          workspace: { type: 'string', description: '按工作区标题/路径/workspaceId 过滤（可选）' },
          limit: { type: 'number', description: '最多返回条数，默认 30' },
        },
        additionalProperties: false,
      },
      output: OUTPUT_STR,
      async execute(args, exec) {
        const { peer } = await bridge.resolvePeer(args?.peer)
        const { gateway } = await bridge.gatewayFor(peer.deviceId)
        const limit = Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 30
        let sessions = (await listSessions(bridge, gateway, exec?.signal)).map(sessionSummary)
        let scope = ''
        if (args?.workspace) {
          const items = await listWorkspaces(bridge, gateway, exec?.signal)
          const ws = pickWorkspace(items, args.workspace, null)
          if (ws) {
            const ids = new Set(ws.sessionIds ?? [])
            sessions = sessions.filter((s) => ids.has(s.sessionId))
            scope = `（工作区「${ws.title}」）`
          } else {
            scope = `（未匹配到工作区「${args.workspace}」，返回全部）`
          }
        }
        sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        const shown = sessions.slice(0, limit)
        if (shown.length === 0) return `对端「${peer.name}」没有会话${scope}。`
        return (
          `对端「${peer.name}」的会话${scope}：显示 ${shown.length}/${sessions.length}\n` +
          shown
            .map((s) => {
              const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '-'
              return `  ${s.sessionId}\n    ${s.title || '(无标题)'}  ${s.running ? '[运行中]' : ''}\n    cwd: ${s.cwd || '-'}  更新: ${when}`
            })
            .join('\n')
        )
      },
    },

    {
      name: 'dual_send',
      description:
        '给对端机器上的一个会话发消息并等回复（跨机双向沟通的核心工具）。默认复用固定会话；没给 session 也没有配置默认会话时会新建一个会话。给了 workspaceId/workspace 时新会话会挂到该工作区，对端 UI 侧栏实时可见。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '要发送的文本（必填）。建议开头带方向标记，如【私人机→公司机】' },
          peer: { type: 'string', description: '对端名称或 deviceId；省略用默认对端' },
          session: { type: 'string', description: '对端会话 id（复用已有会话）；省略用配置的默认会话，再没有则新建' },
          workspace: { type: 'string', description: '新会话挂到的工作区：标题/路径/workspaceId' },
          model: { type: 'string', description: 'provider/model，如 workbuddy-xdpool-global/deepseek-v4.1-flash；省略用默认模型' },
          timeoutMs: { type: 'number', description: '等待回复的毫秒数；省略用配置值（默认 600000）' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      output: OUTPUT_STR,
      async execute(args, exec) {
        const message = typeof args?.message === 'string' ? args.message : ''
        if (!message.trim()) throw Object.assign(new Error('message 不能为空'), { code: 'BRIDGE_EMPTY_MESSAGE' })
        const { peer } = await bridge.resolvePeer(args?.peer)
        const { gateway } = await bridge.gatewayFor(peer.deviceId)

        const modelSpec = (typeof args?.model === 'string' && args.model.includes('/') ? args.model : cfg.defaultModel).trim()
        const slash = modelSpec.indexOf('/')
        const provider = modelSpec.slice(0, slash)
        const model = modelSpec.slice(slash + 1)

        // 1) 定会话
        let sessionId = (typeof args?.session === 'string' && args.session.trim()) || cfg.defaultSession || ''
        let created = false
        let workspaceLabel = ''
        if (!sessionId) {
          const wantWs = args?.workspace || cfg.defaultWorkspace
          let ws = null
          const items = wantWs || cfg.autoWorkspace ? await listWorkspaces(bridge, gateway, exec?.signal) : []
          if (wantWs) {
            ws = pickWorkspace(items, wantWs, /^[0-9a-fA-F-]{36}$/.test(wantWs) ? wantWs : null)
            if (!ws && /^[0-9a-fA-F-]{36}$/.test(wantWs)) {
              throw Object.assign(new Error('workspaceId 未命中：' + wantWs), { code: 'BRIDGE_WORKSPACE_NOT_FOUND' })
            }
          }
          if (!ws && cfg.autoWorkspace) {
            // 兜底：挑对端「最近更新」的工作区。这样建出来的会话一定挂在对端工作区上，
            // 对端 UI 侧栏实时可见（否则就是游离会话，对端根本看不到）。
            ws = [...items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null
            if (ws) workspaceLabel = `${ws.title} (${ws.path})  [自动选取：最近更新]`
          }
          const request = ws ? { workspaceId: ws.workspaceId } : {}
          const res = await bridge.invoke(gateway, 'session', 'create', request, exec?.signal)
          sessionId = res?.sessionId
          created = true
          if (ws) workspaceLabel = workspaceLabel || `${ws.title} (${ws.path})`
          else workspaceLabel = '(游离会话，对端 UI 侧栏不可见)'
          if (!sessionId) throw Object.assign(new Error('对端未返回新会话 id：' + JSON.stringify(res)), { code: 'BRIDGE_CREATE_FAILED' })
        }

        // 2) 选模型
        let modelNote = ''
        try {
          await bridge.invoke(gateway, 'session', 'selectModel', { sessionId, provider, model }, exec?.signal)
          modelNote = `${provider}/${model}`
        } catch (err) {
          modelNote = `沿用对端当前模型（设置失败：${err?.message ?? err}）`
        }

        // 3) 起流 + 下发
        const timeoutMs = Number.isFinite(Number(args?.timeoutMs)) && Number(args.timeoutMs) >= 5000 ? Number(args.timeoutMs) : cfg.timeoutMs
        const ac = new AbortController()
        const onAbort = () => ac.abort()
        exec?.signal?.addEventListener?.('abort', onAbort, { once: true })
        const deadline = Date.now() + timeoutMs
        const replies = []
        const toolsUsed = []
        let turnError = null
        let done = false

        const stream = await gateway.open(
          'session/follow',
          { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } },
          ac.signal,
        )
        const pump = (async () => {
          try {
            for await (const frame of stream) {
              if (frame?.type !== 'event') continue
              const ev = frame.event
              if (ev?.type === 'assistant/message') {
                const t = textOfContent(ev.data?.message?.content)
                if (t) replies.push(t)
              } else if (ev?.type === 'turn/end') {
                const reason = ev.data?.reason ?? {}
                if (reason.kind === 'error') turnError = reason.error?.message || 'remote turn failed'
                done = true
              } else if (ev?.type === 'tool/call') {
                const n = ev.data?.name || ev.data?.toolName
                if (n) toolsUsed.push(n)
              }
            }
          } catch {
            /* abort / 流关闭 */
          }
        })()

        await sleep(1000)
        const requestId = 'req-' + Date.now()
        await bridge.invoke(
          gateway,
          'session',
          'prompt',
          { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: message }] },
          exec?.signal,
        )

        while (!done && Date.now() < deadline) await sleep(800)
        const timedOut = !done
        ac.abort()
        try {
          await pump
        } catch {
          /* ignore */
        }
        exec?.signal?.removeEventListener?.('abort', onAbort)

        const head = [
          `对端     : ${peer.name}`,
          `会话     : ${sessionId}${created ? '（新建）' : '（复用）'}`,
          workspaceLabel ? `工作区   : ${workspaceLabel}` : null,
          `模型     : ${modelNote}`,
          `耗时     : ${Date.now() - (deadline - timeoutMs)}ms${timedOut ? '（等待超时，仅收到部分回复）' : ''}`,
          toolsUsed.length ? `对端工具 : ${toolsUsed.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n')

        const body = replies.length ? replies.join('\n---\n') : '(没有文本回复)'
        const tail = turnError ? `\n\n⚠ 对端回合出错：${turnError}` : ''
        return `${head}\n\n=== 对端回复 ===\n${body}${tail}`
      },
    },

    {
      name: 'dual_inbox',
      description:
        '只读：读对端某个会话的最近消息（不新建会话、不下发任务、不选模型）。用于查看对方给你留了什么、或确认上一条任务到底落到哪个会话里。',
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: '对端名称或 deviceId；省略用默认对端' },
          session: { type: 'string', description: '对端会话 id；省略用配置的默认会话' },
          limit: { type: 'number', description: '最多返回多少条最近消息，默认 20' },
        },
        additionalProperties: false,
      },
      output: OUTPUT_STR,
      async execute(args, exec) {
        const { peer } = await bridge.resolvePeer(args?.peer)
        const sessionId = (typeof args?.session === 'string' && args.session.trim()) || cfg.defaultSession
        if (!sessionId) {
          throw Object.assign(new Error('未指定 session，且没有配置 defaultSession。请给 session 参数，或用 dual_sessions 先查会话 id。'), {
            code: 'BRIDGE_NO_SESSION',
          })
        }
        const limit = Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 20
        const { gateway } = await bridge.gatewayFor(peer.deviceId)
        const snapshot = await readSnapshot(gateway, sessionId, exec?.signal)
        if (!snapshot) return `对端「${peer.name}」会话 ${sessionId} 没有读到快照（可能会话不存在或对端无响应）。`

        const msgs = []
        for (const rec of snapshot.records ?? []) {
          const ev = rec?.event
          if (!ev) continue
          if (ev.type === 'user/message') {
            const t = textOfContent(ev.data?.content) || textOfContent(ev.data?.message?.content)
            if (t) msgs.push({ at: ev.time, who: '用户', text: t })
          } else if (ev.type === 'assistant/message') {
            const t = textOfContent(ev.data?.message?.content)
            if (t) msgs.push({ at: ev.time, who: '对端助手', text: t })
          }
        }
        const shown = msgs.slice(-limit)
        const head = [
          `对端   : ${peer.name}`,
          `会话   : ${sessionId}`,
          `标题   : ${snapshot.projections?.values?.title ?? '(无)'}`,
          `cwd    : ${snapshot.header?.cwd ?? '-'}`,
          `共 ${msgs.length} 条消息，显示最近 ${shown.length} 条（cursor=${snapshot.cursor}）`,
        ].join('\n')
        if (shown.length === 0) return head + '\n\n(该会话还没有文本消息)'
        const body = shown
          .map((m) => {
            const when = m.at ? new Date(m.at).toLocaleString('zh-CN') : '-'
            const one = m.text.length > 1500 ? m.text.slice(0, 1500) + '\n…(截断)' : m.text
            return `── [${when}] ${m.who} ──\n${one}`
          })
          .join('\n\n')
        return head + '\n\n' + body
      },
    },
  ]
}

// ─────────────────────────── 插件入口 ───────────────────────────

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const bridge = new Bridge(ctx, cfg)
  const disposers = []

  for (const def of toolDefs(bridge)) {
    const dispose = ctx.tools.register(def)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    return bridge.close()
  }, 'dsh-dual-bridge: tools + transport')
}
