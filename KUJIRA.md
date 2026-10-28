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

主会话不出现在侧栏的会话列表里。`ApiSessionList.list` 只遍历
`sessionQuery.listSessions()`（磁盘记录），而尚未产生任何事件的空会话不落盘。
dsh 自身的「新会话」走客户端草稿态，发第一条消息后才写入，所以没有可复用的空白行。
人格卡片上提供了「打开主会话」入口作为替代路径。
