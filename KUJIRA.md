# Kujira Chan 部署说明

本文件记录 `kujira-chan` 分支在一个 Alibaba Cloud Linux 3 云服务器上的部署方式、
构建约束和维护流程。所有改动都在本分支内，未向上游提交。

## 本分支相对上游的改动

| 提交 | 内容 |
|---|---|
| `bcd1949754` | `feat(web)`：`DSH_WEB_PASSWORD` 环境变量启用 HTTP Basic 认证 |
| `52437853a4` | `chore(brand)`：侧栏品牌名改为 Kujira Chan（8 个语言包） |
| `1f46674b8a` | `chore(brand)`：Web 文档标题默认值改为 Kujira Chan |

### 认证改动说明

`dsh web` 原本只支持 launch token（每次启动打印带 `?token=` 的 URL，换取 30 天签名
cookie）。改动位于 `packages/client/connection/src/browser-auth.ts`：

- 读取 `DSH_WEB_PASSWORD` 环境变量；**未设置或为空时行为与上游完全一致**
- 设置后，index 请求接受 `Authorization: Basic` 凭据
- 校验通过后签发与 token 路径完全相同的、绑定 authority 的签名 cookie
- 401 响应附带 `WWW-Authenticate: Basic realm="DeepSeek Harness"`

密码比较走 SHA-256 摘要 + `timingSafeEqual`，不泄露长度或前缀。

### 品牌改动说明

- `packages/client/locale/src/locales/*.ts` 的 `brand.localBuild` 统一为 `Kujira Chan`
- `apps/web/vite.config.ts` 的 `DEFAULT_CLIENT_TITLE` 由 `DSH Local Build` 改为 `Kujira Chan`

两处配合后，即使不传任何环境变量，构建产物也显示 Kujira Chan。

> 注意：`apps/web/tests/` 与 `packages/client/ui-sidebar/tests/` 中仍保留着
> 断言 `DSH Local Build` 的测试用例，本地跑这两组测试会失败。运行不受影响。

## 运行环境

- Node.js 24.22.1（`engines.node >= 24.9.0`）
- pnpm 11.28.5（仓库 `packageManager` 固定版本，通过 corepack 激活）
- git 2.43.7
- 自定义 TLS 证书（自签，SAN 含公网 IP 与内网 IP）

## 构建约束（重要）

目标服务器物理内存仅 **1.8 GB**，且实测 swap **不参与回收**（分配 2.2 GB 即被
OOM killer 终止，swap 用量几乎为 0，即使 `swappiness=100`、`overcommit=1`）。

因此：

- **不能**直接运行 `pnpm run build:artifacts` 或 `pnpm run build`
  全量 `tsc -b <tsconfig.host.json references>` 会把 310 个项目塞进一个进程，
  峰值超过 2 GB，必然 SIGKILL
- **必须**逐个项目编译，单个 `tsc -b` 进程峰值仅约 250 MB

推荐流程：

```bash
pnpm install

# 逐个编译 host 与 client 的每个项目（脚本见下）
bash scripts/build-sequential.sh

# 打包与前端构建（这三步内存峰值约 800 MB ~ 1.4 GB，单进程可完成）
pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE host
pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE client
pnpm run build:web
```

`scripts/build-sequential.sh` 的内容：

```bash
#!/bin/bash
set -u
cd "$(dirname "$0")/.."
TSC=./node_modules/.bin/tsc

build_list() {
  local cfg="$1" out="$2"
  node --input-type=module -e "
import ts from 'typescript'
const r = ts.readConfigFile('$cfg', ts.sys.readFile)
console.log((r.config.references ?? []).map((x) => x.path).join('\n'))
" > "$out"
  while IFS= read -r p; do
    "$TSC" -b "$p" >/tmp/tsc-one.log 2>&1 || { echo "FAIL $p"; tail -n 2 /tmp/tsc-one.log; }
  done < "$out"
}

build_list tsconfig.host.json   /tmp/host-refs.txt
build_list tsconfig.client.json /tmp/client-refs.txt
```

桌面端产物（`pnpm --filter @deepseek-ai/dsh-desktop run bundle`）在只跑 Web 时可以跳过。

## 服务配置

systemd unit（`/etc/systemd/system/dsh-web.service`）：

```ini
[Unit]
Description=DeepSeek Harness Web UI (kujira-chan source checkout)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/kujira-chan
Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0
Environment=DSH_WEB_PASSWORD=<见服务器上的 unit 文件，不入库>
ExecStart=/usr/local/bin/pnpm dsh web --no-open \
  --host <内网地址> --port 8443 \
  --public-url https://<公网地址>:8443/ \
  --trusted-host <公网地址>:8443 \
  --tls-cert /root/.dsh-web-tls/cert.pem \
  --tls-key /root/.dsh-web-tls/key.pem
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

要点：

- 服务绑定内网地址而非 `0.0.0.0`（`dsh web --host` 拒绝通配地址）
- 使用 `--public-url` 与 `--trusted-host` 让 cookie 的 authority 与浏览器实际地址一致
- 公网访问需要在云平台安全组放行对应端口

## 日常维护

```bash
cd /opt/kujira-chan
git pull

# 场景一：只改了 host 侧（服务端逻辑、认证等）
systemctl restart dsh-web          # tsx 直接运行 TypeScript 源码，重启即生效

# 场景二：改了 client 侧（packages/client/**、locale、UI）
./node_modules/.bin/tsc -b packages/client/<pkg>/tsconfig.client.json
pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE client
pnpm run build:web
systemctl restart dsh-web

# 场景三：改了某个包的 src（TypeScript）
# tsc 产物是 tsdown 的输入，必须先 tsc 再 tsdown，只重跑 tsdown 不会生效
```

常用命令：

```bash
systemctl status dsh-web
systemctl restart dsh-web
journalctl -u dsh-web -f
```

## 已知限制

1. 内存受限，全量构建无法进行，只能逐项目编译
2. 自签证书，浏览器首次访问需要手动信任
3. `DSH_WEB_PASSWORD` 以环境变量形式存在于 systemd unit 中（unit 权限 `600`），
   不是独立的凭据存储
4. 上游若改动 `browser-auth.ts` 或 locale / vite 默认值，`git pull` 时可能产生冲突

## Kujira Chan 内置插件

`packages/client/ui-settings-kujira-chan` 是本分支自带的插件，注册在 Web 客户端
Plugins 页面的 `plugins.item` 槽位（内置插件 / Official 分组）。

| 文件 | 作用 |
|---|---|
| `src/index.ts` | Host 半：空 `apply()`，让插件出现在 Loader 与内置插件清单里 |
| `src/client/index.ts` | 注册 `plugins.item`，id `kujira-chan`，order 100 |
| `src/client/KujiraChanPage.tsx` | `summary` 视图返回卡片一行描述，`page` 视图是当前的空配置页 |
| `src/client/locales.ts` | 中英文案 |

注册点共三处：

```
tsconfig.client.json                                client aggregate reference
packages/bundle/web-app/package.json                workspace dependency
packages/bundle/web-app/cordis.patch.yml            loader entry ui-settings-kujira-chan
```

### 构建注意

在线 `pnpm install` 在无法访问 `cdn.sheetjs.com`（`xlsx` 的 tarball）时会失败。
本包没有新增外部依赖，因此可以只补 workspace 符号链接：

```bash
ln -sfn ../../../../client/ui-settings-kujira-chan \
  packages/bundle/web-app/node_modules/@deepseek-ai/dsh-client-ui-settings-kujira-chan
```

`pnpm-lock.yaml` 此时不含该包记录；网络恢复后需要补跑一次 `pnpm install`，
否则 `--frozen-lockfile` 安装会失败。

构建步骤与主流程一致：`tsc -b` 该包 → `tsdown --env.DSH_BUILD_FACE client`
→ `pnpm run build:web` → 重启服务。

## Kujira Chan 人格功能

`packages/host/kujira-chan`（`@deepseek-ai/dsh-host-kujira-chan`）维护一份人格列表；
每个人格对应一个工作区，并在该工作区里自动创建一个主会话。

### 数据与位置

| 项 | 位置 |
|---|---|
| 人格列表 | `~/.dsh/kujira-personas.json` |
| 人格工作区 | `~/Documents/deepseek-harness/personas/<slug>-<8位随机>` |
| 主会话标题 | `<人格名> · 主会话` |

`create` 依次执行：`mkdir` → `workspaceRegistry.create(path, name)` →
`sessionController.create({ workspaceId })` → `sessionController.rename(...)`。
`drop` 依据调用方选项决定是否 `workspaceRegistry.delete` + `rm -rf` 目录，
以及是否 `workspaceController.archiveSession`。

### Remote 方法

| 方法 | 说明 |
|---|---|
| `kujiraPersona/list` | 读取人格列表 |
| `kujiraPersona/create` | 创建人格 + 工作区 + 主会话 |
| `kujiraPersona/drop` | 移除人格，可带 `deleteWorkspace` / `archiveSession` |

> `drop` 不能命名为 `remove`：`RemoteNamespaceService` 自身拥有 `remove()` 原型方法，
> `assertMethodAvailable` 会拒绝同名 Remote 方法，整个 Client 装配会挂载失败。

### 使功能生效需要的服务器侧配置

这些在仓库之外，重建环境时必须手工补上。

**1. profile 层（`~/.dsh/profiles/web/cordis.patch.yml`）**

```yaml
- id: workspace-controller
  name: "@deepseek-ai/dsh-api-workspace-controller"
  config:
    documentsDirectory: /root/Documents

- id: typert-loader
  name: "@deepseek-ai/dsh-typert-loader"
  config:
    packages:
      - "@deepseek-ai/dsh-host-kujira-chan"
```

前者避开无头主机缺失的 `xdg-user-dir`；后者让 `typert-loader` 加载本包的
`./typert` 清单，否则它会静默跳过，Client 的 `$mount` 随之失败并连带 62 个插件 pending。

**2. Client 装配登记（`packages/api/remotes/src/client/index.ts`）**

Remote namespace 必须显式加入挂载数组，否则 `ctx.remote.kujiraPersona` 不存在：

```ts
import kujiraPersonaRemote from '@deepseek-ai/dsh-host-kujira-chan/remote'
...
kujiraPersonaRemote,
```

同时 Client 插件的 `inject` 必须逐项列出 namespace：

```ts
export const inject = ['slots', 'locale', 'remote', 'remote.kujiraPersona', 'uiWorkspace']
```

只写 `remote` 会得到 `cannot get property "remote.kujiraPersona" without inject`。

**3. 手工 node_modules 链接**

`pnpm install` 在当前网络环境会卡在 `cdn.sheetjs.com`（`xlsx` 的 tarball）超时，
新包因此没有依赖链接，需要手工补：

```bash
H=packages/host/kujira-chan/node_modules/@deepseek-ai
mkdir -p "$H"
ln -sfn ../../../../typert/protocol          "$H/dsh-typert-protocol"
ln -sfn ../../../../api/session-controller    "$H/dsh-api-session-controller"
ln -sfn ../../../../workspace/workspace       "$H/dsh-workspace"
ln -sfn ../../../../api/remote-access         "$H/dsh-api-remote-access"
ln -sfn ../../../../api/workspace-controller  "$H/dsh-api-workspace-controller"
ln -sfn ../../../../../vendor/cordis          "$H/cordis"

ln -sfn ../../packages/host/kujira-chan node_modules/@deepseek-ai/dsh-host-kujira-chan
ln -sfn ../../../../host/kujira-chan packages/bundle/web-app/node_modules/@deepseek-ai/dsh-host-kujira-chan
```

网络恢复后跑一次 `pnpm install` 即可把 `pnpm-lock.yaml` 补全并替代这些链接。

### 已知限制

主会话创建后会收到一条种子 `user` 消息（`【初始化】「<人格名>」主会话已就绪…`），
因此它会落盘并出现在侧栏。种子消息必须保持 `user` 身份：只有 `user/message` 会启动
一轮，会话跑过一轮才会持久化。代价是创建人格时会触发一次模型调用。

> 早期版本把主从规则写在这条种子消息里；现在规则改由系统提示的
> 「Kujira Chan 主从会话约定」常驻提供，种子消息只负责触发与落盘。

子会话的挂起轮**不设时间上限**，只有两种结束方式：主会话回复，或用户取消。
若主会话因故完全不回复，子会话会一直停在思考态，需要在主会话界面点「停止」。

### 主从会话：其他会话的消息如何进入主会话

每个人格的主会话是唯一**真正调用模型**的会话。同一工作区里的其他会话（子会话）
只负责接收用户输入，把消息交给主会话，再把答案呈现出来——它们自己不消耗 token。

```text
子会话发消息
  → Host 入队（按人格串行）
  → 主会话收到「[来自子会话 xxxxxxxx · 回复用 kujira_send；不需要时可以不回复] …」
  → 主会话调用 kujira_send(session_id, message, quote?)
  → 有挂起轮：流式写回那一轮；没有挂起轮：写进历史并直接发通道（主动消息）
```

工具只有一个 `kujira_send`：「回复某人」和「主动开口」在模型侧是同一个动作，
由会话当前有没有等待中的轮次决定走哪条路。

**常驻系统提示**

每个人格主会话的系统提示里都常驻一段「Kujira Chan 主从会话约定」，写在
`deployment:persona-prefix` 段（与人格提示词同段，先约定后人格）：

```text
【Kujira Chan 主从会话约定 · 系统指令】
你是本工作区的主会话，是这里唯一负责思考和作答的 agent。
- 你收到的每一条 user 消息都不是真人直接发来的，而是工作区里其他会话转发过来的，正文前标注「[来自子会话 <短id> 的消息]」。
- 真正的人在别的会话里，看不到你在这里的输出。直接回答没有用，只有调用工具才算回复。
- 回复方式：kujira_send(session_id="<短id>", message="<你的回复>")。
- 默认不引用对方原消息；需要引用某一条时，给 kujira_send 带上 quote 参数（写那条消息正文的开头一段），匹配不到会报错。
- 收到「[来自子会话 <短id> 的停止请求]」时，立即停止当前处理，不要再调用任何工具。
- 你可以用 kujira_persona_prompt 查看或改写自己的人格提示词：不传 prompt 是查看，传 prompt 是改写。
- 需要过一会儿自己再行动时，用 kujira_wake 安排一次唤醒：给 in（如 10m、2h）或 at（ISO 时间），可带 reason 说明到点要做什么。
【约定结束】
```

规则放在系统提示而不是转发正文里，是为了只在上下文出现一次，而不是每条消息重复。
未配置人格提示词时，系统提示里只有这段约定。

转发正文只有前缀一行：

```text
[来自子会话 758b072e · 回复用 kujira_send；不需要时可以不回复]
<消息正文>
```

前缀刻意不给参数签名——签名在系统提示里；同时明确「可以不回复」，让模型对无需回应的
消息有拒绝的余地。

**转发与静默**

`packages/host/kujira-chan` 监听 `agent/inbox/spliced` 与 `session/event`，命中人格工作区的
非主会话时把消息入队，并注册一个**实时探针**：

```ts
sharedSlot[Symbol.for('dsh.kujira.isForwardOnly')] = (sessionId) => { /* cwd + personas */ }
```

`packages/llm/llm-deepseek/src/adapter.ts` 在每次请求前调用它。命中时该轮**不发请求**，
挂起等待；探测是同步判断的，不依赖任何标记文件的写入时序。

> 早先用「写一个静默会话列表文件、adapter 读文件」实现，会输给竞态：子会话自己的
> 模型请求常常在标记落盘前就已发出。文件列表仍保留为兜底。

**挂起与流式回复**

挂起的轮在共享 Map `dsh.kujira.forwardWaiters` 上登记一个 sink，每 120 ms 把新增文本
作为 `text-delta` 吐出。因此 `kujira_send` **调用一次就投递一次**，但子会话里始终是
同一条消息在增长，最终仍是一段完整回复。

主会话 `turn/end` 时 Host 把 sink 标记为结束；若那一轮已被插话消耗掉，则改为追加
一条独立消息，保证答案不丢。

**插话与停止**

| 场景 | 行为 |
|---|---|
| 主会话有正在运行的轮次，子会话又发消息 | `prompt(mode: 'steer')` 插进当前轮；子会话当前那一步**保持挂起**，消息留在它的 inbox 里，回复仍落在它自己的 step 上 |
| 主会话已经把这条插话写进自己的历史 | Host 认出来，这时才结束子会话的当前 step，让下一步去消费那条消息 |
| 主会话已经没有在跑的轮次 | 进队列，排队等下一次 |
| 在子会话点停止 | 给主会话 steer 一条「用户已停止」，**让模型自己收手**，不使用 `cancel` |

插话的判定依据是「主会话此刻有没有在跑的 turn」，不是「是否已经回复过」——
后者会让同轮里的第二次插话失效。

**主会话的输入**

主会话的 composer 不再被替换，而是给会话 raise 一个 **composer block**
（`ctx.conversation.blocks.set(sessionId, { reason })`）：

- 文本输入被拒绝，占位提示是「这是人格主会话。请在该工作区的其他会话里发起对话。」
- 模型选择、权限设置、停止按钮**全部保留**，链路异常时可以从停止按钮收手

早先是整块接管 composer 的，后来发现那样连模型选择和停止按钮一起被藏掉了。

**会话 ID 的短写法**

转发给主会话的是 8 位短 id（`session-<uuid>` 的 uuid 前 8 位），工具收到后由 Host
解析回完整会话；传完整 id 或唯一前缀也能识别。

**跨包耦合点**

| 包 | 角色 |
|---|---|
| `packages/host/kujira-chan` | 队列、转发、探针注册、投递、`kujira_send` / `kujira_persona_prompt` / `kujira_wake` |
| `packages/llm/llm-deepseek/src/adapter.ts` | 静默判断、挂起循环、把回复作为本轮流式输出 |
| `packages/client/ui-settings-kujira-chan` | 人格页、主会话 composer block、停止按钮 |
| `packages/channel/onebot` | QQ 通道；服务面暴露 `send` / `sendMarked` / `keyOfSession` |
| `packages/memory/workspace-memory` | 工作区记忆；跳过人格子会话 |

三者通过 `globalThis` 上的两个 symbol 通信：
`Symbol.for('dsh.kujira.isForwardOnly')`（探针）与
`Symbol.for('dsh.kujira.forwardWaiters')`（sink 表）。

## 三个工具

主会话能用的工具都在 `packages/host/kujira-chan`，只有人格主会话可以调用。

| 工具 | 作用 |
|---|---|
| `kujira_send(session_id, message, quote?)` | 把一个消息投递给工作区里的子会话 |
| `kujira_persona_prompt(prompt?)` | 读或改写自己的人格提示词 |
| `kujira_wake(in?, at?, reason?, cancel?)` | 安排一次自我唤醒 |

### 投递语义

`kujira_send` 只有一条对外路径，但内部按目标会话的状态分两种：

```text
目标会话有挂起轮（对方正等着）
  → 流式写进那个 sink，QQ 侧看到的是这一轮的回复
目标会话没有挂起轮（主动开口）
  → 写进历史（自成一轮完整的 turn）
  → 经通道服务直接发出去
```

主动那条必须写成一整轮（`turn/start → step/start → assistant/message → step/end → turn/end`）。
直接往一个已关闭的 turn 上挂 `assistant/message` 会让日志校验失败
（`assistant/message does not match an open turn and step`），会话从此打不开。

### 引用

`quote` 传的是**内容前缀**，不是消息 id：

```text
kujira_send(session_id="46e209f4", message="好的", quote="该吃饭啦")
```

通道在自己的缓存里找最近一条正文以该前缀开头的消息，用它的 `message_id` 做引用。
**匹配不到就报错**，不会静默降级——这样模型能立刻知道引用没成立。

前缀通过正文前的标记传递（`\u200b<前缀>\u200b<正文>`）：标记会写进子会话的
assistant 历史，但子会话不跑模型、主会话也只读转发过来的 user 内容，没有模型会读到它。

### 唤醒

```text
kujira_wake({ in: "10m", reason: "..." })
kujira_wake({ at: "2026-10-31T22:00:00+08:00", reason: "..." })
kujira_wake({ cancel: "<id>" })
```

- 到点后主会话收到一条 `[定时唤醒] <reason>`，由它自己决定做什么
- 记录写在 `~/.dsh/kujira-wakeups.json`，进程重启后重新装载；停机期间到点的会在启动时立刻补发
- 唤醒任务**绑死会话 id**：重启后那个会话可能不在内存里，投递时会先 `sessionController.resolveAgent` 把它从磁盘恢复，再写历史、再发通道
- 短 id 的解析不只查内存映射，还会回退到内存会话列表和持久化列表做前缀匹配

### 记忆插件与子会话

`workspace-memory` 的两个钩子都会跳过人格子会话：

| 钩子 | 行为 |
|---|---|
| `agent/pre-step`（注入记忆） | 子会话直接 `return next()`，不注入 |
| `agent/turn-stopping`（落盘） | 子会话跳过，不写 |

判断复用 kujira 的探针 `dsh.kujira.isForwardOnly`（cwd 属于某人格工作区且会话不是该人格主会话），
两边不会各写一份再慢慢跑偏。否则同一句对话会被主会话和子会话各记一遍，记忆文件迅速膨胀。

### 通道侧需要的能力

`onebot` 通过 `ctx.provide('onebot', ...)` 暴露：

| 方法 | 用途 |
|---|---|
| `send(key, message, opts)` | 按会话 key 发送 |
| `sendMarked(key, marked)` | 发送带引用标记的正文（主动消息用） |
| `keyOfSession(sessionId)` | 会话 id → QQ 会话 key 反查 |
| `sessionKeys()` / `stats()` / `build()` | 诊断与预构造 |

会话 key → session id 的映射落在 `~/.dsh/onebot-sessions.json`，重启后据此接回同一批会话。

## 登录页

未认证访问不再弹出浏览器原生的 Basic Auth 对话框，而是返回一个独立登录页
（`DSH_WEB_PASSWORD` 未设置时行为不变，仍是 401）。

流程：

| 步骤 | 结果 |
|---|---|
| `GET /` 无 cookie | `200` 返回登录页 HTML |
| `POST /login` 密码错误 | `401` 重新渲染登录页并提示 |
| `POST /login` 密码正确 | `303` 到 `./`，下发签名 cookie |
| 带 cookie 访问 `/` | 正常返回 Web UI |

实现分三处：

- `packages/client/connection/src/browser-auth.ts`
  `loginPageDocument()` 提供 HTML；`issueSession()` 校验密码并签发与 token 路径相同的 cookie
- `packages/client/connection/src/rpc-host.ts` + `rpc.ts`
  在 `HostConnectionHandle` 上暴露 `issueLoginCookie()` / `loginPage()`
- `packages/host/frontend-static/src/index.ts`
  注册 exact `/login` 路由处理 POST。不能用 fallback 座位：`WebRoute` 的 fallback 只接受
  GET/HEAD，POST 会被 webserver 以 405 拒绝

> cookie 的 audience 必须与 `requestAudience()` 的校验形状一致：HTTPS 监听器写
> `url.origin`（`https://host:port`），HTTP 写 `url.host`。签发时若直接存裸 `Host` 头，
> HTTPS 下永远匹配不上，登录会看似成功却仍然停在登录页。

### 人格提示词的编辑

每个人格卡片有「配置」按钮，展开后可编辑该人格的提示词，保存写入
`~/.dsh/kujira-personas.json` 的 `prompt` 字段（可选字段，旧记录没有也能读）。

对应 Remote 方法 `kujiraPersona/update`。新增 Remote 端点时还要在
`packages/experimental/liveshare/src/endpoint-classification.ts` 补一行
`'kujiraPersona/update': 'owner-only'`，否则该包的编译期完整性闸门会拒绝构建。

提示词通过 `dsh-system-prompt` 的装配 waterfall 注入：本服务监听
`system-prompt/assemble`，从 context 取 Agent（`Agent.id` 即 sessionId），在人格表里
找到该会话的人格，再把文本写进 `deployment:persona-prefix` 段——与 `dsh-persona` 占用的
同一个段，所以是替换而非追加。每轮装配都按 sessionId 选取，两个会话不会互相污染。

> 早期版本曾把提示词写入工作区 `AGENTS.md`，那条路径已移除：它走的是
> `dsh-agent-instructions` 的用户消息注入，权重低于系统提示，且会与 waterfall 重复注入。

> `AGENTS.md`（`dsh-agent-instructions` 会从工作目录向上加载），这一步尚未实现。
