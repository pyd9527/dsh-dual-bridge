# 双向沟通桥（dsh-dual-bridge）

把已装的 `ds-harness-remote` 通道封装成模型可以直接调用的工具：跨机发一段话、取回对端回复、列对端工作区与会话。复用现有身份与 relay，不新建身份、不重复登录、不改动原插件与原脚本。

- 包类型：Host 插件（无 UI 客户端代码），`export function apply(ctx, config)`
- 依赖：本机已装并已登录 `ds-harness-remote`（本插件通过 `ctx.inject(['dshRemoteClient'], ...)` 复用它的运行时）
- 不提供：新账号体系、新的 relay 服务、对端的任何写操作（只发消息、建会话）

---

## 一、装插件三步

### 第 1 步：把包放进机器

把整个 `dsh-dual-bridge` 目录放到本机任意路径（工作区内即可，例如 `D:\plugins\dsh-dual-bridge`）。目录里应有 `package.json`、`index.js`、`cordis.patch.yml`、`locale\`、`icon.svg`。

### 第 2 步：安装到 desktop profile

两种方式，选一种：

**A. 命令行（推荐，不受 UI 独占影响）**

```powershell
dsh plugin --profile desktop add "D:\plugins\dsh-dual-bridge"
```

- `dsh` 必须在 PATH 上；路径写**绝对路径**，含空格时加引号。
- 这条命令等价于在 desktop profile 里跑 pnpm 装包，不需要 DSH Desktop 正在运行。
- 公司机（DSH 装在 `D:\AZ\DSH Desktop`）用命令行装最稳：UI 安装有时会被正在运行的实例占住 profile 目录。

**B. 会话内让模型装**

让模型调用 `plugin_manager`：

```
action = "install_bundle"
target = "D:\plugins\dsh-dual-bridge"
```

若返回 `pendingBuilds`，要先明确同意再传 `approvedBuilds`；本插件无构建脚本，正常不会出现。

### 第 3 步：完全退出 DSH Desktop 再启动

**彻底关闭** DSH Desktop（确认进程真的退出，含托盘与后台进程），然后重新启动。

- 新装 bundle 有时能热加载激活，但**热加载不认新包的 Host 行与工具注册**；本插件的正确生效方式是完整重启一次。
- 重启后在插件清单里应能看到卡片：标题「双向沟通桥」，图标为双向箭头。

### 第 4 步：两台机器登录同一个账号

两台机器都打开 DSH 的 **Remote 面板**，用**同一个 DeepSeek 账号**登录。登录后：

- 本机获得 client 身份（写入身份目录）；
- 对端出现在本机设备目录里；
- 插件工具才能按名字或 deviceId 找到对端。

> 说明：Remote 面板的入口与登录方式由 `ds-harness-remote` 提供，本插件不参与登录流程。

### 验证

让模型调用 `dual_status`，应看到本机 Remote 身份、relay 连接状态；再调 `dual_peers`，应看到对端为 `online`。

---

## 二、配置项

写在 profile 的 bundle patch（`cordis.patch.yml`）里 `dsh-dual-bridge` 这条 entry 的 `config` 下。**7 个键，全部可选**：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `serverUrl` | string | `https://dsh.r2049.cn` | relay 服务地址。官方免费，WebRTC/P2P 打不通时自动降级 relay。正常不用改 |
| `defaultPeer` | string | 空 | 默认对端：对端**名称**或 deviceId。留空 = 用第一个在线对端 |
| `defaultWorkspace` | string | 空 | 默认远端工作区：工作区 **title** 或 workspaceId。`dual_send` 不传 `sessionId` 时用它新建可见会话 |
| `defaultSession` | string | 空 | 固定会话 id。填了就默认往这个会话发，保证对端 UI 可见、上下文连续 |
| `defaultModel` | string | 空 | 默认模型，写 `provider/model` |
| `timeoutMs` | number | `600000` | 单次等待对端回复的超时（毫秒），10 分钟。对端跑长任务时调大 |
| `connectMode` | `'reuse'` \| `'connect'` | `'reuse'` | `reuse`：复用已建立的连接，没有就按需建连；`connect`：每次调用前主动建连。零侵入场景用默认值 |

配置示例（片段）：

```yaml
- id: dual-bridge
  name: dsh-dual-bridge
  config:
    serverUrl: https://dsh.r2049.cn
    defaultPeer: 公司机
    defaultWorkspace: <见本机配置>
    defaultSession: <见本机配置>
    defaultModel: deepseek/deepseek-chat
    timeoutMs: 600000
    connectMode: reuse
```

> `defaultModel` 的确切写法（provider 前缀是否必需）**待 Lead 确认**；拿不准就留空，让对端用它自己的默认模型。

---

## 三、模型可见工具

共 6 个。

| 工具名 | 作用 | 关键参数 |
| --- | --- | --- |
| `dual_status` | 报本机 Remote 身份（deviceId / 名称）、relay 连接状态、当前远端目标 | 无 |
| `dual_peers` | 列出可用对端：运行时发现的主机，标出 `online` / `offline` | 无 |
| `dual_workspaces` | 列对端远端工作区（workspaceId / path / title / session 数） | `device` 或 `peer` |
| `dual_sessions` | 列对端远端会话，可按工作区过滤 | `device` 或 `peer`；可选 `workspaceId` |
| `dual_send` | **核心**：向对端发一段文本并取回回复 | 见下表 |
| `dual_inbox` | 取对端某个会话的**最新回复**，**不新建会话**（只读） | `device` 或 `peer`；`sessionId`（缺省用配置里的固定会话）；可选 `limit` |

`dual_send` 参数：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `device` / `peer` | 否 | 配置的 `defaultPeer`，否则第一个在线对端 | 对端名称或 deviceId |
| `text` | 是 | — | 要发的文本 |
| `sessionId` | 否 | 配置的 `defaultSession` | 复用会话追问。与 `workspaceId` 互斥，填了它就不会新建会话 |
| `workspaceId` | 否 | 配置的 `defaultWorkspace` | 指定对端工作区**新建**会话（对端 UI 实时可见）。都不填则按对端 cwd 兜底 |
| `model` | 否 | 配置的 `defaultModel` | 本次使用的模型 |
| `timeoutMs` | 否 | 全局 `timeoutMs` | 本次等待超时 |
| `marker` | 否 | `true` | 是否在文本前自动加方向标记，如 `【私人机→公司机】` |

`dual_inbox` 用于「只要看，不要发」的场景：比如先确认对端那条固定会话里最后说了什么，避免盲目追问。

---

## 四、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `dual_peers` 里对端显示 `offline` | 对端 DSH 没开 / 对端没登录 Remote / 网络到 relay 不通 | 在对端机器打开 DSH 并在 Remote 面板确认已连接；重试 `dual_peers`；确认能访问 `https://dsh.r2049.cn` |
| 报「本机还没有 client 身份」 | 本机没登录 Remote，或身份目录缺 `client\device.json` | 在 DSH 的 Remote 面板用同一个 DeepSeek 账号登录生成身份；确认身份目录存在；重启 DSH 后再试 |
| 对端回复 `context overflow` | 对端会话累积过长，或对端默认模型上下文偏小 | 用 `workspaceId` 新建会话换新上下文；或 `dual_send` 显式指定 `model`；或先在对端把旧会话收口 |
| 公司机安装被占住、装不进去 | 正在运行的 Desktop 实例持有 profile 目录（独占闸门） | **用命令行装**：`dsh plugin --profile desktop add <包目录绝对路径>`；必要时先完全退出 Desktop 再装 |
| 重装后 deviceId 变了 | 身份文件被删/重置，插件重新生成新身份 | 属正常现象。把配置里的 deviceId 改成新值，或干脆只用**名称**匹配；也可两台机重新登录一次 |
| `session/create` 报 `ENOENT` 路径 | 给对端传了一个在对端机器上不存在的 `cwd` | **别自己加 cwd**；用 `workspaceId` 指定对端已有工作区。若必须传 cwd，只能填对端机器上真实存在的绝对路径 |
| 重启后仍看不到插件卡片 | 装到了别的 profile，或没真正重启 | 确认命令里是 `--profile desktop`；确认 Desktop 进程已完全退出后重新启动 |
| 对端 UI 看不到消息 | 会话是「游离会话」（按 cwd 兜底建出来的） | 用 `workspaceId` 建会话（会触发对端 attachSession，UI 实时可见）；或把固定会话写进 `defaultSession` |
| `dual_inbox` 取不到内容 | 会话 id 失效，或对端那条会话还没回复 | 先用 `dual_sessions` 确认会话仍在；必要时用 `dual_send` 带 `workspaceId` 新建会话 |

---

## 五、为什么不影响现有双向沟通

**复用，不替换。** 本插件是现有双向沟通之上的一层封装，不是替代品。零侵入的四个关键事实：

1. **不新建身份**：身份仍由 `ds-harness-remote` 在既有身份目录里维护，本插件只读它，不调用身份创建/重置。
2. **不重新登录**：不触发任何授权、扫码、账号登录流程。
3. **不调用 `setMode`**：不切换本机的远端/本地模式，因此**不改 UI 的远端选择开关**。本插件通过 `ctx.inject(['dshRemoteClient'])` 复用已装 `ds-harness-remote` 提供的运行时，用 `ensureConnected()` 建连 —— 该方法只改内部连接状态，不动 UI 开关；连上之后由本插件自建 gateway 收发消息。已实测验证：连接期间本机 UI 的远端选择状态无变化。
4. **不改动传输层**：`ds-harness-remote` 的包目录、配置、`dshRemote` / `dshRemoteClient` 服务都保持原样。

另外：

- **不影响原脚本**：手写的 `dsh-remote-task.mjs` 及其 `--list` / `--workspaces` / `--session` / `--workspace-id` 用法照旧可用；固定会话继续复用同一个会话。
- **方向标记沿用既有约定**：`【私人机→公司机】` / `【公司机→私人机】`，由 `dual_send` 的 `marker` 自动加。

想回到纯脚本方式，直接跑原命令即可，两者可以同时存在。

---

## 附：本包文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单，声明 `dsh.bundle.patch`、`icon`、`exports` |
| `cordis.patch.yml` | bundle 补丁，插入插件行 |
| `index.js` | Host 插件实现（注册 6 个工具） |
| `locale\zh.json` / `locale\en.json` | 插件卡片标题与描述 |
| `icon.svg` | 卡片图标 |

换电脑、换 DSH 版本、新加一台电脑的完整落地步骤见 `docs\新电脑装机与团队组建.md`。
