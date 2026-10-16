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
const VERSION = '0.2.1'
const DEFAULT_MODEL = 'workbuddy-xdpool-global/deepseek-v4.1-flash'
const DEFAULT_TIMEOUT_MS = 600_000
const FALLBACK_HARNESS_VERSION = '0.2.0-rc.2'
const PLUGIN_DIR = 'ds-harness-remote'
const SILENT = { info() {}, warn() {}, error() {}, debug() {} }

// 「通道掉了」这类可恢复错误的特征。命中就丢缓存连接、强制重连再重试一次。
//   · The authenticated Noise channel is not connected. —— P2P 通道静默失效后的第一次调用
//   · RPC harness.remote.call timed out after 60000ms  —— 死通道上的 RPC 拖到 60s 才超时
//   · remote/disconnected / socket hang up / ECONNRESET —— 传输层已断
const TRANSIENT_RE = /Noise channel is not connected|RPC .* timed out after|remote\/disconnected|socket hang up|ECONNRESET|not connected/i

// 对端「上游模型供应商」拒绝的回合错误（不是通道问题，也不是本插件缺陷）。
// 实测：公司机上 workbuddy-xdpool-global（国际版）会被 workbuddy 上游按渠道校验拦掉，
// 报 code 11128 "conversation id missing" + displayTips「这次调用没通过渠道校验」；
// 同一时刻原版脚本 dsh-remote-task.mjs 下发同样报 400，换 provider 为 workbuddy-xdpool（国内版）即通。
// 触发条件在对端账号/渠道侧，改本机只能换 provider 或换对端模型。
const UPSTREAM_RE = /workbuddy upstream client|conversation id missing|渠道校验|11128/i

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
      if (cached && cached.remote?.client && !cached.remote.client.closed) {
        // 缓存里的连接也必须探活：`client.closed` 为 false 不等于 Noise 握手还在
        // （实测会撞上 "The authenticated Noise channel is not connected."）。
        // 探测是一次最便宜的只读调用，失败就丢掉缓存、重新建连。
        if (await probeGateway(cached.gateway, this.cfg.probeTimeoutMs)) return cached
        this.gateways.delete(deviceId)
      }
    }

    let remote = await this.connectOnce(runtime, deviceId)
    let gateway = this.makeGateway(runtime, remote)
    if (await probeGateway(gateway, this.cfg.probeTimeoutMs)) {
      const entry = { gateway, remote }
      this.gateways.set(deviceId, entry)
      return entry
    }

    // 探测失败：先在本运行时内换一条新连接（关旧、强制重连）。
    // 这是最轻的修法，不新增第二个运行时。
    remote = await this.connectOnce(runtime, deviceId, { force: true })
    gateway = this.makeGateway(runtime, remote)
    if (await probeGateway(gateway, this.cfg.probeTimeoutMs)) {
      const entry = { gateway, remote }
      this.gateways.set(deviceId, entry)
      return entry
    }

    // 还是不通。若是复用宿主运行时且允许回退，才退到自建运行时
    // （同一身份目录，不新建身份、不重新登录）。自建运行时的连接已在上一步
    // 强制重连过，仍然不通就是真不通，直接报错。
    if (!this.ownsRuntime && this.cfg.runtimeMode === 'auto') {
      await this.fallbackToOwn('宿主 dshRemoteClient 的连接不可用（健康探测两次失败）')
      remote = await this.connectOnce(this.runtime, deviceId, { force: true })
      gateway = this.makeGateway(this.runtime, remote)
      if (await probeGateway(gateway, this.cfg.probeTimeoutMs)) {
        const entry = { gateway, remote }
        this.gateways.set(deviceId, entry)
        return entry
      }
    }

    throw Object.assign(
      new Error(
        '连上了对端，但通道发不出请求。请确认对端 DSH 在线；若对端刚重启过，稍等几秒重试；' +
          '仍不行就在 Remote 面板重新登录一次（两台机同一账号）。',
      ),
      { code: 'BRIDGE_CHANNEL_DEAD' },
    )
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

  /**
   * 带自愈的执行：拿网关 → 跑 fn(gateway)；若撞上「通道掉了/超时」这类可恢复错误，
   * 丢掉缓存连接、强制重连，再重试一次。
   *
   * 触发条件来自实测：P2P 通道会静默失效，此后第一次调用报
   * `The authenticated Noise channel is not connected.`，或者一路等到
   * `RPC harness.remote.call timed out after 60000ms`。这两种都不是配置错，
   * 重连一次即可恢复（原版脚本之所以从不出这个问题，是因为它每次都是新进程、
   * 每次重新建连；插件是长驻进程，必须自己处理）。
   */
  async call(deviceId, fn, { signal } = {}) {
    let lastErr
    for (let attempt = 0; attempt < 2; attempt++) {
      const { gateway } = await this.gatewayFor(deviceId)
      try {
        return await fn(gateway)
      } catch (err) {
        lastErr = err
        const msg = String(err?.message ?? err)
        if (!TRANSIENT_RE.test(msg)) throw err
        this.gateways.delete(deviceId)
        try {
          await this.connectOnce(await this.runtimeOf(), deviceId, { force: true })
        } catch {
          /* 重连失败就让下一轮 gatewayFor 自己去探 */
        }
        if (signal?.aborted) throw err
      }
    }
    throw lastErr
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
        lines.push('  运行时来源 : ' + cfg.runtimeMode + (bridge.fallbackReason ? '（已回退：' + bridge.fallbackReason + '）' : ''))
        lines.push('  插件版本   : ' + VERSION)
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
        const items = await bridge.call(peer.deviceId, (gateway) => listWorkspaces(bridge, gateway, exec?.signal), { signal: exec?.signal })
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
        const limit = Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 30
        const wantWorkspace = args?.workspace
        const result = await bridge.call(
          peer.deviceId,
          async (gateway) => {
            let sessions = (await listSessions(bridge, gateway, exec?.signal)).map(sessionSummary)
            let scope = ''
            if (wantWorkspace) {
              const items = await listWorkspaces(bridge, gateway, exec?.signal)
              const ws = pickWorkspace(items, wantWorkspace, null)
              if (ws) {
                const ids = new Set(ws.sessionIds ?? [])
                sessions = sessions.filter((s) => ids.has(s.sessionId))
                scope = `（工作区「${ws.title}」）`
              } else {
                scope = `（未匹配到工作区「${wantWorkspace}」，返回全部）`
              }
            }
            return { sessions, scope }
          },
          { signal: exec?.signal },
        )
        let { sessions, scope } = result
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

        const modelSpec = (typeof args?.model === 'string' && args.model.includes('/') ? args.model : cfg.defaultModel).trim()
        const slash = modelSpec.indexOf('/')
        const provider = modelSpec.slice(0, slash)
        const model = modelSpec.slice(slash + 1)

        // 1) 定会话 + 选模型。放在 call() 里：若撞上通道掉线，这一步会整体重做
        //    （此时消息还没发出去，重做是安全的）。
        const setup = await bridge.call(
          peer.deviceId,
          async (gateway) => {
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

            let modelNote = ''
            try {
              await bridge.invoke(gateway, 'session', 'selectModel', { sessionId, provider, model }, exec?.signal)
              modelNote = `${provider}/${model}`
            } catch (err) {
              modelNote = `沿用对端当前模型（设置失败：${err?.message ?? err}）`
            }
            return { gateway, sessionId, created, workspaceLabel, modelNote }
          },
          { signal: exec?.signal },
        )

        const { gateway, sessionId, created, workspaceLabel, modelNote } = setup

        // 2) 起流 + 下发。这一段不再自动重试：prompt 一旦被对端接受，
        //    重试会把同一条消息发第二遍。失败就如实报出来。
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
        // 对端上游渠道拒绝时附上可操作处置：换 provider / 换对端模型（属对端账号侧，本机改不了）
        const hint = turnError && UPSTREAM_RE.test(turnError)
          ? '\n\n💡 这是对端「上游模型供应商」按渠道校验拒绝（不是通道故障，也不是本插件缺陷）：' +
            '换一个 provider 重试，例如把 model 传成 ' +
            '`workbuddy-xdpool/deepseek-v4.1-flash`（国内版，实测可用）。\n' +
            '   原版脚本 `dsh-remote-task.mjs` 在同一时刻下发会报同样的 400 —— 可据此区分「插件问题」与「对端渠道问题」。'
          : ''
        return `${head}\n\n=== 对端回复 ===\n${body}${tail}${hint}`
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
        const snapshot = await bridge.call(
          peer.deviceId,
          (gateway) => readSnapshot(gateway, sessionId, exec?.signal),
          { signal: exec?.signal },
        )
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

// ─────────────────────────── 内置技能 ───────────────────────────
//
// 借 dsh-interconnect 的做法：把「怎么用这套工具」注册成一条 skill，
// 模型不必翻 README 就知道该按什么顺序调、哪些坑不能踩。

const SKILL_NAME = 'dual-bridge'

function skillContent(cfg) {
  const peer = cfg.defaultPeer || '（未固定，取第一个在线对端）'
  const session = cfg.defaultSession || '（未固定，按需新建）'
  const workspace = cfg.defaultWorkspace || '（未固定，取对端最近更新的工作区）'
  return `# 双向沟通桥（dsh-dual-bridge）

把本机与另一台电脑上的 DSH 打通：发消息过去、取回复回来、看对端有哪些工作区和会话。
底层复用已装的 \`ds-harness-remote\` 通道（同一个 relay + 同一个 DeepSeek 账号即自动配对），
本桥不新建身份、不重新登录、不改动本机 UI 的远端选择状态。

## 当前配置
- 对端（defaultPeer）   : ${peer}
- 会话（defaultSession）: ${session}
- 工作区（defaultWorkspace）: ${workspace}
- 模型（defaultModel）  : ${cfg.defaultModel}
- 自动挂工作区          : ${cfg.autoWorkspace ? '开' : '关'}

## 工具与调用顺序

| 工具 | 用途 | 何时用 |
| --- | --- | --- |
| \`dual_status\` | 自检：本机身份、relay、对端在线情况、运行时来源、插件版本 | 任何跨机操作之前先跑一次；排障也从它开始 |
| \`dual_peers\` | 列出已配对且在线/离线的对端 | 需要确认目标名称或 deviceId 时 |
| \`dual_workspaces\` | 列对端工作区（title / path / workspaceId / 会话数） | 想知道消息会落到对端哪个工作区时 |
| \`dual_sessions\` | 列对端会话（可按 workspace 过滤、客户端排序分页） | 需要复用某个已有会话（上下文连续）时 |
| \`dual_send\` | **发任务/消息给对端并等回复**（核心工具） | 派活、提问、让对端执行操作 |
| \`dual_inbox\` | **只读**：取对端某个会话的最近消息 | 看对端回了什么、翻历史，不下发任务 |

典型顺序：\`dual_status\` → （需要时 \`dual_workspaces\`/\`dual_sessions\`） → \`dual_send\` → 需要回看时 \`dual_inbox\`。

## 关键约定

1. **消息开头带方向标记**，让对端一眼看出是谁发的：
   \`【私人机→公司机】…\` 或 \`【公司机→私人机】…\`。
2. **要复用同一会话就把 \`session\` 传进去**（或用配置里的 \`defaultSession\`）。
   传了会话，上下文连续、对端 UI 里就是同一条对话；
   不传则新建——默认 \`autoWorkspace\` 会把新会话挂到**对端最近更新的工作区**，
   这样对端 UI 侧栏才看得见（只传 cwd 的游离会话对端看不到）。
3. **\`dual_send\` 是阻塞的**：它会一直等到对端这一轮 turn 结束（或超时 \`timeoutMs\`，默认 600 秒）。
   长时间任务要显式传大一点的 \`timeoutMs\`；只想丢个通知不等回复时，别用 \`dual_send\`。
4. **一次只发一件清楚的事**。对端是另一个 Agent，含糊的多目标指令容易只做一半。
5. **\`dual_inbox\` 只读**：它不新建会话、不下发任务，纯粹读对端会话最近 N 条消息。

## 组队思路（多台机器）

- 每台机器装一次本插件（包内 \`install.mjs\` 一条命令：体检 → 找 dsh CLI → 缺通道自动补装 → 装本插件）。
- 两台机用**同一个 DeepSeek 账号**登录**同一个 relay**（默认 \`https://dsh.r2049.cn\`）才会互相配对。
- 把「谁负责什么」写成各自的固定会话（\`defaultSession\`），机器之间用 \`dual_send\` 互相派活，
  每台机再各自开自己的 Agent 团队——跨机的分工靠会话标题与方向标记维持，不靠共享内存。

## 排障速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| \`BRIDGE_NO_PEER\` | 没有任何在线对端 | 确认对端 DSH 开着、两边同一账号登录同一 relay |
| \`BRIDGE_PEER_OFFLINE\` | 指定的对端离线 | 换 \`peer\`，或先让对端上线 |
| \`RPC harness.remote.call timed out after 60000ms\` | 宿主缓存的连接已死 | 默认 \`runtimeMode: auto\` 会自动探测并退回自建运行时；仍复现就把 \`runtimeMode\` 设成 \`own\` |
| \`BRIDGE_CHANNEL_DEAD\` | 连上了但通道发不出请求 | 让对端在 Remote 面板重新登录一次后重试 |
| 对端 UI 看不到消息 | 会话是游离会话（\`autoWorkspace\` 被关且没给 \`workspace\`） | 保持 \`autoWorkspace: true\`，或显式给 \`workspace\` |
| 工具报「没有这两个字段」之类 | 对端 DSH 版本较老，端点形状不同 | 本桥会自动换参数形状重试；仍失败说明该远端版本不支持该能力 |
`
}

function registerSkill(ctx, cfg) {
  if (!ctx.skills || typeof ctx.skills.register !== 'function') return
  try {
    ctx.skills.register({
      name: SKILL_NAME,
      description: '跨机双向沟通：给另一台电脑上的 DSH 发消息、取回复、看对端工作区与会话（dsh-dual-bridge 的 dual_* 工具用法与排障）。',
      whenToUse: '需要与另一台电脑上的 DSH 互通（派活、提问、取对端回复、看对端会话），或 dual_* 工具报错需要排障时。',
      content: skillContent(cfg),
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'dsh-dual-bridge',
    })
  } catch {
    /* 技能注册失败不影响工具可用 */
  }
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

  // 技能是可选能力：没有 skills 服务时工具照常可用。
  // 优先走 ctx.inject(['skills'])（等 skills 服务就绪再注册，与 cordis 依赖声明语义一致）；
  // 若宿主 ctx 没有 inject（例如精简测试上下文），直接尝试注册一次，失败就跳过。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      registerSkill(skillCtx, cfg)
    })
  } else {
    registerSkill(ctx, cfg)
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
