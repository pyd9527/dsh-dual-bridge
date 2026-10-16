# 双向沟通桥（dsh-dual-bridge）

把已装的 `ds-harness-remote` 通道封装成模型可以直接调用的工具：跨机发一段话、取回对端回复、列对端工作区与会话。复用现有身份与 relay，不新建身份、不重复登录、不改动原插件与原脚本。

- 包类型：Host 插件（无 UI 客户端代码），`export function apply(ctx, config)`
- 当前版本：`0.1.1`
- 依赖：本机已装并已登录 `ds-harness-remote`。插件优先 `ctx.get('dshRemoteClient')` 复用宿主的运行时；拿不到就自建一个 `ClientModeRuntime`，**共用同一份身份目录**（`$DSH_HOME\remote\servers\<serverHash>\client`），不新建身份、不重新登录
- 不提供：新账号体系、新的 relay 服务、对端的任何写操作（只发消息、建会话、读会话快照）

---

## 一、装插件三步

### 第 1 步：把包放进机器并安装

把整个 `dsh-dual-bridge` 目录放到本机任意路径（工作区内即可，例如 `D:\plugins\dsh-dual-bridge`）。目录里应有 `package.json`、`index.js`、`cordis.patch.yml`、`install.mjs`、`icon.svg`、`locale\`、`README.md`。

三种安装方式，任选一种。**新电脑上首选 A。**

**A. 装机脚本 `install.mjs`（推荐，换电脑/换 DSH 一条命令搞定）**

包内自带 `install.mjs`，一条命令完成「体检 → 找 `dsh` CLI → 缺通道就自动补装 → 装本插件」：

```powershell
cd "D:\plugins\dsh-dual-bridge"
node install.mjs                 # 体检 + 缺 ds-harness-remote 就自动补装 + 装本插件
node install.mjs --check         # 只体检，不安装（退出码 0 = 体检与 CLI 都正常，2 = 有问题）
node install.mjs --profile web   # 装进其它 profile（默认 desktop）
node install.mjs --no-transport  # 不自动补装通道
node install.mjs --dir <目录>    # 显式指定插件目录（默认脚本所在目录）
```

它按顺序做四件事：

1. **体检** —— profile 目录是否存在、`ds-harness-remote` 是否已装、本机 client 身份是否已生成。
2. **找 `dsh` CLI** —— 先查 PATH；查不到就扫 `%APPDATA%\DSH Desktop\host-commands\<profile>\generations\<hash>\bin\dsh.cmd`。
3. **补装通道** —— profile 里缺 `ds-harness-remote` 就自动跑 `dsh plugin --profile desktop add ds-harness-remote@0.5.7`。**这一步是「换了电脑装插件就能用」的关键**：以前新机器得先自己装通道再装本插件，现在一条命令搞定。（`--no-transport` 可关掉这步。）
4. **装本插件** —— `dsh plugin --profile desktop add <包目录>`。

它**不写任何 profile 文件、不改 `ds-harness-remote` 本体、不碰身份目录**。`package.json` 已声明 `bin`，装完后可直接用 `dsh-dual-bridge-install` 调用同一脚本。

- 脚本报「profile 目录不存在」时，先打开一次 DSH Desktop（它会建好 profile）再重跑。
- 脚本末尾会打印「接下来三步」，并按保守做法提示**完全退出 DSH Desktop 再打开**：命令行装的包属「冷装」，不像会话内 `install_bundle` 那样实测到热加载，重开一次最稳（想省这一步就先试 `dual_status`，工具在就不用重开）。

**B. 命令行（不受 UI 独占影响）**

```powershell
dsh plugin --profile desktop add "D:\plugins\dsh-dual-bridge"
```

- `dsh` 必须在 PATH 上；路径写**绝对路径**，含空格时加引号。
- 这条命令等价于在 desktop profile 里跑 pnpm 装包，不需要 DSH Desktop 正在运行。
- 公司机（DSH 装在 `D:\AZ\DSH Desktop`）用命令行装最稳：UI 安装有时会被正在运行的实例占住 profile 目录。
- 本机当前是 `link:` 形式（pnpm link），`node_modules\dsh-dual-bridge` 是指向工作区的符号链接。**换电脑时把整个目录拷过去**，再对新目录的绝对路径跑上面这条命令。

**C. 会话内让模型装**

让模型调用 `plugin_manager`：

```
action = "install_bundle"
target = "D:\plugins\dsh-dual-bridge"
```

若返回 `pendingBuilds`，要先明确同意再传 `approvedBuilds`；本插件无构建脚本，正常不会出现。

### 第 2 步：两台机器用同一个账号登录 Remote

两台机器都打开 DSH 的 **Remote 面板**，用**同一个 DeepSeek 账号**登录。登录后：

- 本机获得 client 身份（写入身份目录）；
- 对端出现在本机设备目录里；
- 插件工具才能按名称或 deviceId 找到对端。

> 说明：Remote 面板的入口与登录方式由 `ds-harness-remote` 提供，本插件不参与登录流程。

### 第 3 步：验证（装完即用，不需要重启）

实测：`plugin_manager` 的 `install_bundle` 返回 `application: "applied"` 时，Host 已经**热加载**并注册了 6 个工具（用 `cordis_inspect_query` 的 host / `listTools` 能直接看到）。

让模型调用 `dual_status`，应看到本机 Remote 身份、relay 连接状态、运行时来源与插件版本；再调 `dual_peers`，应看到对端为 `在线`。

> ⚠ **例外：改过插件自身的代码之后，必须完全退出 DSH Desktop 再打开。**
> 首次安装（`install_bundle` 返回 `application: "applied"`）确实是热加载、装完即用；但**装完之后再改插件代码，运行中的 Host 不会重新加载** —— 实测改内容后 toggle 插件不生效、把入口改名（`impl-0.1.1.js`）不生效、再改名（`bridge.js`）并改 `package.json` 的 `exports` 也不生效，`dual_status` 始终返回旧版输出（Host 里的 ESM 模块缓存不会被清掉）。而用新进程 `import()` 同一个文件，新版代码立刻生效。⇒ **改代码后一律完全退出 DSH Desktop 再打开。**
> **判断方法**：`dual_status` 输出里应有「运行时来源 : …」与「插件版本 : 0.1.1」两行。**没有这两行，就是在跑旧代码。**

**如果工具没出现**，再完全退出 DSH Desktop（确认进程真的退出，含托盘与后台进程）重新打开一次。

**一个容易误判的现象**：profile 的 `cordis.patch.yml` 里**看不到** `dual-bridge` 这条 row —— 这是正常的。bundle patch 是运行时合成的，不写回 profile 文件；以「工具在不在」为准，不要以文件里有没有那一行为准。

---

## 二、配置项

写在 profile 的 bundle patch（`cordis.patch.yml`）里 `dsh-dual-bridge` 这条 entry 的 `config` 下。**9 个键，全部可选**，都有默认值：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `serverUrl` | string | `https://dsh.r2049.cn` | relay 服务地址。官方免费，WebRTC/P2P 打不通时自动降级 relay。正常不用改 |
| `defaultPeer` | string | 空 | 默认对端：对端**名称**或 deviceId。留空 = 用第一个在线对端 |
| `defaultWorkspace` | string | 空 | 默认远端工作区：工作区 **title**、**path** 或 workspaceId。`dual_send` 不传 `session` 时用它新建可见会话 |
| `defaultSession` | string | 空 | 固定会话 id。填了就默认往这个会话发，保证对端 UI 可见、上下文连续 |
| `defaultModel` | string | `workbuddy-xdpool-global/deepseek-v4.1-flash` | 默认模型，**必须写成 `provider/model`**（不含 `/` 的值会被忽略、回落到默认值） |
| `timeoutMs` | number | `600000` | 单次等待对端回复的超时（毫秒，10 分钟）。对端跑长任务时调大。小于 5000 的值会被忽略 |
| `connectMode` | `'reuse'` \| `'connect'` | `'reuse'` | `reuse`：缓存并复用连接（缓存里那条还活着就直接用）；`connect`：每次调用都新建连接，不缓存 |
| `autoWorkspace` | boolean | `true` | 未指定 `session`/`workspace` 时，新建会话**自动挂到对端「最近更新」的工作区**。开着才能保证新会话在对端 UI 侧栏实时可见；关掉则回落建游离会话（对端看不到） |
| `runtimeMode` | `'auto'` \| `'own'` \| `'host'` | `'auto'` | 运行时来源，见下 |

**`runtimeMode` 三种取值**

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 优先复用宿主 `dshRemoteClient`；但每次拿连接前先做一次轻量健康探测（发一个最便宜的只读调用 `session/list`，超时由 `probeTimeoutMs` 控制）。探测失败就**自动整体退回自建运行时**（共用同一身份目录，不新建身份、不重新登录），`dual_status` 里会标出「已回退：<原因>」 |
| `own` | 始终自建运行时。宿主那条连接不可靠、或想完全绕开宿主时用 |
| `host` | 只用宿主运行时；拿不到就直接报错 `BRIDGE_NO_HOST_RUNTIME` |

**隐藏项**：`probeTimeoutMs`（number，默认 `4000`，最小 `500`）—— 连接健康探测的超时，一般不用写。

配置示例（片段）：

```yaml
- id: dual-bridge
  name: dsh-dual-bridge
  config:
    serverUrl: https://dsh.r2049.cn
    defaultPeer: 公司机
    defaultWorkspace: <见本机配置>
    defaultSession: <见本机配置>
    timeoutMs: 600000
    connectMode: reuse
    autoWorkspace: true
    runtimeMode: auto
```

> 示例里的 `defaultPeer: 公司机` 是给人看的方向叫法。**实际值必须等于 `dual_peers` 列出的对端名称或它的 deviceId**，否则会报 `BRIDGE_PEER_NOT_FOUND`（报错信息里会把已知对端列出来，照抄即可）。本插件不提供别名表，名称就是设备名本身。

---

## 三、模型可见工具

共 6 个。

| 工具名 | 作用 | 关键参数 |
| --- | --- | --- |
| `dual_status` | 报本机身份（deviceName / deviceId / serverUrl / 身份来源 / 连接状态 / 连接模式 / **运行时来源** / **插件版本**）、默认配置、已配对对端及在线情况 | 无 |
| `dual_peers` | 列出已配对的对端设备（deviceId、名称、是否在线） | 无 |
| `dual_workspaces` | 列对端远端工作区（workspaceId / title / path / 会话数） | `peer` |
| `dual_sessions` | 列对端远端会话（sessionId / 标题 / cwd / 更新时间 / 是否运行中），可按工作区过滤 | `peer`；可选 `workspace`；可选 `limit`（默认 30） |
| `dual_send` | **核心**：向对端发一段文本并取回回复 | 见下表 |
| `dual_inbox` | 只读：读对端某个会话的最近消息（**不新建会话、不下发任务、不选模型**） | `peer`；`session`（缺省用配置的 `defaultSession`）；可选 `limit`（默认 20） |

**`dual_send` 参数**（以下为插件实际接受的参数名）：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `message` | **是** | — | 要发送的文本。为空会报 `BRIDGE_EMPTY_MESSAGE` |
| `peer` | 否 | 配置的 `defaultPeer`，否则第一个在线对端 | 对端名称或 deviceId |
| `session` | 否 | 配置的 `defaultSession` | 复用已有会话。填了它就不会新建会话 |
| `workspace` | 否 | 配置的 `defaultWorkspace` | 指定对端工作区**新建**会话（对端 UI 侧栏实时可见）。可写 title / path / workspaceId；写 workspaceId 未命中会报 `BRIDGE_WORKSPACE_NOT_FOUND`。都不填时，`autoWorkspace` 打开就自动挑对端「最近更新」的工作区 |
| `model` | 否 | 配置的 `defaultModel` | 本次使用的模型，写 `provider/model`。设置失败不致命，会沿用对端当前模型并在输出里注明 |
| `timeoutMs` | 否 | 全局 `timeoutMs` | 本次等待超时（毫秒，最小 5000）。超时只会返回已收到的部分回复，输出里会标注「等待超时」 |

**方向标记要自己写**：`dual_send` **没有** `marker` 参数，插件不会自动往文本前加标记。跨机消息按约定在 `message` 开头自己带上 `【私人机→公司机】` 或 `【公司机→私人机】`。

`dual_inbox` 用于「只要看，不要发」的场景：比如先确认对端那条固定会话里最后说了什么，避免盲目追问。它只读会话快照，不产生任何对端动作。

`dual_send` 的返回包含：对端名称、会话 id（标注新建/复用）、工作区（自动选取时会注明）、模型、耗时、对端用到的工具，然后是 `=== 对端回复 ===` 正文。

### 实测样例（v0.1.1，私人机 → 公司机）

以下是真机跑通的行为，可当作「它能干什么」的参考。具体 id 请以本机 `dual_peers` / `dual_workspaces` / `dual_sessions` 的输出为准，不写进文档。

| 动作 | 实测结果 |
| --- | --- |
| `dual_workspaces` | 列出对端 4 个工作区：双向沟通（`D:\remote\workspace`，6 个会话）、记忆中枢、日常工作（9 个会话）、default-workspace |
| `dual_send`（复用固定会话） | 对端回复「桥已就绪 v0.1」/「插件通道 OK」，单次耗时 6.8 ~ 7.6 秒 |
| `dual_inbox {limit:2}` | 只读读到该会话最近 2 条（一条用户消息 + 一条对端助手回复） |
| `autoWorkspace` 兜底 | 不配任何 workspace/session 时新建会话，对端 UI 侧栏**能看到**；实测两个兜底会话的 cwd 都是 `D:\remote\workspace`（即对端「最近更新」的工作区） |

---

## 四、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `dual_peers` 里对端显示 `离线` | 对端 DSH 没开 / 对端没登录 Remote / 网络到 relay 不通 | 在对端机器打开 DSH 并在 Remote 面板确认已连接；重试 `dual_peers`；确认能访问 `https://dsh.r2049.cn` |
| 报「本机还没有 client 身份」或「读取对端设备失败：身份未就绪」 | 本机没登录 Remote，或身份目录缺 `client\device.json` | 在 DSH 的 Remote 面板用同一个 DeepSeek 账号登录生成身份；确认身份目录存在；重启 DSH 后再试 |
| 一路等 60 秒后报 `RPC harness.remote.call timed out after 60000ms` | 宿主的 `dshRemoteClient` 把连接缓存在它私有的 `this.connected` 里，`ensureConnected()` 只要 deviceId 相同就直接返回那条连接 —— **哪怕通道早就断了**。之后所有 RPC 都打在死通道上 | `runtimeMode: auto`（默认）会在拿连接前先探测，探测不通就自动整体切到自建运行时，正常不会走到这一步。若仍复现：把 `runtimeMode` 显式设成 `own`，强制走自建运行时；然后看 `dual_status` 的「运行时来源」是否显示已回退及原因 |
| 报 `BRIDGE_NO_HOST_RUNTIME` | 配了 `runtimeMode: host`，但宿主没有可用的 `dshRemoteClient`（身份未就绪，或 `ds-harness-remote` 没加载） | 改成 `auto`（或 `own`）后重试；同时确认本机已在 Remote 面板登录 |
| 报 `BRIDGE_CHANNEL_DEAD` | 连上了对端，但通道发不出请求 | 确认对端 DSH 在线；在对端 Remote 面板重新登录一次；再重试 |
| 对端回复 `context overflow` | 对端会话累积过长，或对端默认模型上下文偏小 | 用 `workspace` 新建会话换新上下文；或 `dual_send` 显式指定 `model`；或先在对端把旧会话收口 |
| 公司机安装被占住、装不进去 | 正在运行的 Desktop 实例持有 profile 目录（独占闸门） | **用命令行装**：`dsh plugin --profile desktop add <包目录绝对路径>`；必要时先完全退出 Desktop 再装 |
| `plugin_manager` 的 `set_plugin` 报 `unknown-plugin` | target 填成了包名 | target 要用 Loader entry id：**`include:dual-bridge`**（不是 `dsh-dual-bridge`） |
| 装完看不到插件卡片或工具 | 没真正激活，或装到了别的 profile | 先确认安装命令里是 `--profile desktop`、且返回 `application: "applied"`（此时已热加载）；仍没有就**完全退出 DSH Desktop 再重开**。注意 profile 的 `cordis.patch.yml` 里看不到 `dual-bridge` row 属正常（bundle patch 运行时合成，不写回文件），别据此判定「没装上」 |
| 重装后 deviceId 变了 | 身份文件被删/重置，插件重新生成新身份 | 属正常现象。把配置里的 deviceId 改成新值，或干脆只用**名称**匹配；也可两台机重新登录一次 |
| `session/create` 报 `ENOENT` 路径 | 给对端传了一个在对端机器上不存在的 `cwd` | **别自己加 cwd**；用 `workspace` 指定对端已有工作区。若必须传 cwd，只能填对端机器上真实存在的绝对路径 |
| 对端 UI 看不到消息 | 会话是「游离会话」（`autoWorkspace` 被关掉、又没给 `workspace` 时按对端 cwd 兜底建出来的） | 保持 `autoWorkspace: true`（默认），或显式给 `workspace`；或把固定会话写进 `defaultSession`。`dual_send` 输出里的「工作区」行会注明是否自动选取、是否游离 |
| 报 `gateway/invocation-unavailable` / `no active Remote method exports this endpoint` | **对端 DSH 版本没有这个能力**（不是形状错）。插件对远端端点做形状自适应调用：`invoke` 先试 `args:{request}`，报 `missing "_request"` / `unexpected "request"` 就改 `{_request}`，再报反向错误就改平铺；若对端确实没导出该端点，远端只会回这条 | 换用 `dual_peers` / `dual_sessions` 等基础工具，或升级对端 DSH。本插件不因版本差异报错 |
| `dual_inbox` 报 `BRIDGE_NO_SESSION` | 没给 `session` 参数，配置里也没有 `defaultSession` | 先用 `dual_sessions` 查会话 id 再传 `session`；或把常用会话写进 `defaultSession` |
| `dual_inbox` 取不到内容 | 会话 id 失效，或对端那条会话还没回复 | 先用 `dual_sessions` 确认会话仍在；必要时用 `dual_send` 带 `workspace` 新建会话 |

---

## 五、为什么不影响现有双向沟通

**复用，不替换。** 本插件是现有双向沟通之上的一层封装，不是替代品。零侵入的证据链：

1. **从不调用 `runtime.setMode()` 与 `selectRemoteTarget()`** —— 这两个是唯一会把本机 UI 的 sessions / workspace / skills / llm / settings 等 **11 个 domain** 转发到远端的机关（`ApiProxySwitch.SWITCHED_DOMAINS`）。插件源码里没有任何一处调用它们。
2. **API 层面根本没有代理开关可被改动**：本机 profile 里 `ClientModeRuntime.proxySwitch` 是 `undefined`（插件 apply 时传入的 `apiProxy` 为 `undefined`，构造器里是 `apiProxy === void 0 ? void 0 : new ApiProxySwitch(apiProxy)`）。
3. **收发走自建 `RemoteTypertGateway`**，不经过宿主的 `gatewaySwitch` 转发。
4. **建连只碰自己的状态**：`ensureConnected()` 只写它自己的 `this.connected`；`connect()` 连这个都不写。插件缓存连接的 map 是插件自己的，关插件时一并清理。
5. **实测回归**：插件装进 desktop profile 后，现有 `dsh-remote-task.mjs` 的 `--list` / `--workspaces` 两条只读回归**全部 PASS**；`ds-harness-remote` 目录 914 个文件，`CRITICAL CHANGED=0`、`IDENTITY CHANGED=0`。

另外：

- **不影响原脚本**：手写的 `dsh-remote-task.mjs` 及其 `--list` / `--workspaces` / `--session` / `--workspace-id` 用法照旧可用；固定会话继续复用同一个会话。想回到纯脚本方式，直接跑原命令即可，两者可以同时存在。
- **方向标记沿用既有约定**：`【私人机→公司机】` / `【公司机→私人机】`，由调用方写在 `message` 开头。
- **迁移时不要删**身份目录、**不要动** `ds-harness-remote` 的配置。

---

## 附：本包文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单，声明 `dsh.bundle.patch`、`icon`、`exports` |
| `cordis.patch.yml` | bundle 补丁，插入插件行（entry id 为 `dual-bridge`） |
| `index.js` | Host 插件实现（注册 6 个工具） |
| `install.mjs` | **推荐装机入口**：体检 + 找 `dsh` CLI + 缺 `ds-harness-remote` 就自动补装 + 调 `dsh plugin --profile <p> add <目录>`（可 `--check` 只体检）。装完也可用 `dsh-dual-bridge-install` 调用 |
| `locale\zh.json` / `locale\en.json` | 插件卡片标题与描述。**必须写成 `{"meta":{"title":"…","description":"…"}}` 包裹** —— 本 build 的读取器只读 `meta.title` / `meta.description`，平铺在顶层的 `title` / `description` 取不到 |
| `icon.svg` | 卡片图标 |

换电脑、换 DSH 版本、新加一台电脑的完整落地步骤见 `docs\新电脑装机与团队组建.md`。
