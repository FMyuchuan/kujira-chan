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
