# Kujira Chan

**Kujira Chan**（鲸鱼娘）是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的个人分支，在一台低配云主机上长期运行。它保留了上游的插件化架构，另加了一层「人格」模型：一个主会话负责思考，同工作区的其他会话和 QQ 通道把消息交给它处理。

上游原始 README 保留在 [README.upstream.md](README.upstream.md)，中文版在 [README.zh.md](README.zh.md)。
部署细节、踩过的坑和恢复清单在 [KUJIRA.md](KUJIRA.md)。

---

## 本分支多了什么

### 登录页

未认证访问不再弹浏览器原生的 Basic Auth 对话框，而是返回一个独立登录页（`DSH_WEB_PASSWORD` 未设置时行为不变）。登录成功后下发与 token 路径相同口径的会话 cookie。

### 品牌

侧栏、标题、登录页统一显示 **Kujira Chan**，`DEFAULT_CLIENT_TITLE` 与八套语言包同步。

### 人格系统

每个人格拥有：

- 一个独立工作区 `~/Documents/deepseek-harness/personas/<slug>-<8位>`
- 一个**主会话**（唯一真正调用模型的地方）
- 一段可编辑的人格提示词，每轮注入系统提示

同工作区的其他会话（Web 子会话、QQ 私聊/群聊）把消息**转发**给主会话，由主会话统一回答，再按会话投递回去。子会话自己不消耗 token。

配套能力：

| 工具 / 页面 | 作用 |
|---|---|
| `kujira_reply(session_id, message, quote?)` | 主会话把回复投递给指定会话 |
| `kujira_persona_prompt(prompt?)` | 主会话查看或改写自己的人格提示词 |
| `kujira_wake({ in, at, reason, cancel })` | 定时唤醒自己，可持久化、可取消 |
| 插件设置页 | 人格列表、提示词编辑、待触发唤醒 |

主会话的输入框被禁用（它不接受直接输入），但模型选择、权限设置、停止按钮保留。

### QQ 通道（OneBot 11）

基于 [dsh-onebot](https://github.com/JackZo400/dsh-onebot)：

- 每个私聊/群聊一个独立 dsh 会话，归入人格工作区
- 消息转发进人格主会话，回复逐段发回 QQ
- 等待期间的新消息按插话处理
- 群里需要 @ 才响应；私聊默认关闭

### 工作区记忆

内置 [@flowingspring/dsh-workspace-memory](https://github.com/lgquan/dsh-workspace-memory)：按工作区保存长期记忆，在 agent 的 `pre-step` 注入，回合结束时落盘。

第三方组件与许可登记在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## 部署

### 环境

- Node.js ≥ 24.9
- pnpm 11（通过 corepack）
- Linux（本分支验证于 Alibaba Cloud Linux 3 / 2 vCPU / 1.8 GiB RAM）

### 构建

> **重要**：客户端产物必须带上 `DSH_CLIENT_VERSION` 与 `DSH_CLIENT_COMMIT_HASH`。裸跑 `tsdown` 会让 `process.env` 变成 `{}`，账号模块会直接抛「this client build carries no DSH_CLIENT_VERSION」。

完整构建（会写 `.dsh-build/client-build-environment.json`）：

```bash
pnpm install --frozen-lockfile
pnpm run build            # 或 pnpm run build:artifacts（跳过类型检查）
```

只重建前端：

```bash
export DSH_CLIENT_VERSION="$(node -p "require('./package.json').version")"
export DSH_CLIENT_COMMIT_HASH="$(git rev-parse --short HEAD)"
pnpm run build:lib:client
pnpm run build:web
```

**低内存主机**：聚合的 `tsc -b` 会 OOM。用逐项目编译代替——`bash /tmp/build-seq.sh` 之类的脚本按 `tsconfig.host.json` / `tsconfig.client.json` 的 references 逐个编译，峰值约 250 MB。

### 运行

源码部署 + systemd：

```ini
[Service]
WorkingDirectory=/opt/kujira-chan
ExecStart=/usr/local/bin/node --import tsx/esm apps/cli/src/bin.ts web \
  --no-open --host 172.27.14.181 --port 8443 \
  --public-url https://<public-ip>:8443/ \
  --trusted-host <public-ip>:8443 \
  --tls-cert /root/.dsh-web-tls/cert.pem \
  --tls-key /root/.dsh-web-tls/key.pem
Environment=DSH_WEB_PASSWORD=<password>
```

---

## 关键包

| 路径 | 作用 |
|---|---|
| `packages/host/kujira-chan` | 人格列表、转发队列、`kujira_reply` / `kujira_persona_prompt` / `kujira_wake` |
| `packages/client/ui-settings-kujira-chan` | 人格设置页、主会话输入框禁用 |
| `packages/channel/onebot` | OneBot 11 通道 |
| `packages/memory/workspace-memory` | 工作区长期记忆 |
| `packages/client/connection` | 登录页与 cookie 签发 |
| `packages/llm/llm-deepseek` | 转发型会话的挂起分支（不请求模型） |

插件装载在 `packages/bundle/web-app/cordis.patch.yml`；服务器侧的 profile 覆盖（含 token、目录）在 `~/.dsh/profiles/web/cordis.patch.yml`。

---

## 已知限制

- 主会话一次只处理一条消息，多个会话同时说话会排队
- 子会话的挂起轮没有时间上限（只在主会话回复或取消时结束）
- 唤醒任务按进程调度，重启后从 `~/.dsh/kujira-wakeups.json` 恢复；停机期间到点的会在启动时立刻补发
- 低内存主机构建时必须逐项目编译，聚合构建会 OOM

---

## 上游

DeepSeek Harness 是 [DeepSeek AI](https://deepseek.com) 的开源项目，基于 [Cordis](https://github.com/cordiverse/cordis) 的插件体系。

- 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 文档：<https://deepseek-harness.github.io/deepseek-harness/>

运行前请阅读上游的 [安全说明](SAFETY.md)。

## 许可

继承上游许可；随附的第三方组件许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
