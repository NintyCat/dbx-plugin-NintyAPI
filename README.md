# NintyAPI — DBX Plugin

在 DBX 中调试 HTTP 接口的插件：类似 Apifox/Postman 的工作台，支持接口集合管理、请求历史、cURL 导入导出。

A DBX plugin that turns the workbench into an API debugging client: organize requests into collections, send HTTP requests through the Go backend, and inspect status/timing/headers/body responses.

## 来源说明 / Provenance

本项目的初始骨架起步于 [eryajf/dbx-plugin-k8s](https://github.com/eryajf/dbx-plugin-k8s)（Apache-2.0）。此后以 AI 辅助进行了全面重写：当前仓库中的全部代码均为本项目自己的实现，不含来自上游的原创表达，功能方向也不同（HTTP API 调试客户端）。在此感谢原项目在起步阶段的参考价值。

NintyAPI started from the plugin skeleton of [eryajf/dbx-plugin-k8s](https://github.com/eryajf/dbx-plugin-k8s) (Apache-2.0) and has since been fully rewritten with AI assistance. All code in this repository is this project's own implementation and contains none of the upstream's original expression; the original project is credited here for provenance.

## 功能

- **接口集合**：目录 + 请求的树形结构，按连接（项目）持久化，支持新建/重命名/级联删除
- **请求编辑器**：方法 + URL + Params / Headers / Body（JSON、XML、文本、表单、multipart 文件、二进制）/ Auth（Bearer、Basic）/ 设置（超时、跟随重定向、TLS 校验）
- **响应面板**：状态码、耗时（DNS/TCP/TLS/TTFB 分解）、大小、响应头、响应体美化（JSON 缩进高亮，HTML/XML/SVG 按元素结构重排并高亮，都由字节判断而非 Content-Type）、二进制 base64 预览；超过 10 MiB 的响应会被截断
- **Cookie 会话**：`Set-Cookie` 自动存入该连接的 Cookie 存储，后续请求（含重定向跳转，仅限同源）自动携带；响应面板 Cookie 页签列出本次请求携带的 Cookie 并标注来源（会话存储 / 手写请求头），可一键清空
- **cURL 互转**：粘贴 cURL 命令一键导入为请求；任意请求可复制为 cURL
- **请求历史**：每连接保留最近 200 条，完整记录请求参数（查询参数/请求头/请求体/认证/设置）、响应与请求时间；单条请求体或响应体最多存 128 KiB，超出部分截断并在界面上标注。点击回放整条记录，右键可重新发送、保存为接口、复制 cURL / 地址 / 响应、生成代码或删除单条
- 中英文界面，跟随 DBX 主题与语言

## RPC 接口

| 方法 | 说明 |
| --- | --- |
| `connection/test` / `connect` / `disconnect` | 探测 Base URL 可达性（任何 HTTP 响应均视为可达） |
| `http/request` | 执行 HTTP 请求，返回状态/头/体/耗时/重定向链，以及本次携带的 Cookie |
| `cookie/clear` | 清空该连接累积的 Cookie（响应面板 Cookie 页签的清除按钮） |
| `collection/list` / `save` / `delete` | 接口集合树管理 |
| `history/list` / `get` / `delete` / `clear` | 请求历史（`list` 只返回行摘要，`get` 返回完整请求与响应） |
| `curl/parse` | 解析 cURL 命令为请求草稿 |
| `clipboard/read-text` | 读取系统剪贴板文本（插件 UI 位于沙箱 iframe，浏览器剪贴板 API 不可用） |
| `clipboard/write-text` | 写入系统剪贴板文本（`host.copy` 与浏览器 API 均不可用时的兜底） |
| `ui/preferences-get` / `set` | UI 偏好（前端 localStorage 桥接） |

## Develop

### Local verification

```bash
cd backend && go test ./...
cd ui && pnpm install --frozen-lockfile && pnpm run build
```

也可以直接运行 `./scripts/build.sh` 完成后端测试、二进制构建和前端构建（无 pnpm 时自动回退 npm）。

Run the backend and DBX development host from the repository root:

```bash
dbx-plugin dev --path . --port 5190
```

Open the loopback URL printed by the command, create an **NintyAPI** connection (Base URL 可留空，此时请求必须使用完整地址), then click **Test** and **Connect**. The workbench opens the API collections pane. Keep this terminal open: backend RPC errors and sidecar startup failures are printed there. Development connection data is stored under `.dbx-dev/` and is ignored by Git.

The Go backend only depends on the DBX plugin SDK (`github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk`, pinned to commit `b5072f1a3e15` via a pseudo-version) plus the standard library. 国内网络可设置 `GOPROXY=https://goproxy.cn,direct`。

To test the packaged artifact rather than the development host:

```bash
dbx-plugin package . --output-dir dist
```

Install the generated unsigned `.dbxp` candidate in a development DBX instance. This catches manifest paths, the backend binary name, and staged UI files that a browser-only check cannot catch.

### Regenerating the icon

`scripts/make-icon.py` 用纯标准库渲染 `assets/plugin.png` 与 `plugin.svg`（无需 Pillow）：

```bash
python3 scripts/make-icon.py assets
```

## Release

1. Publish a GitHub Release. The generated workflow builds unsigned candidates for every target.
2. Open a **Plugin submission Issue** in `t8y2/dbx-store` with the source tag and `release-candidates.json` URL.
3. After review, DBX Store signs approved candidates with the official repository key and publishes the installable assets.
4. Open the final catalog PR against **`t8y2/dbx-store:main`** using the signed artifact metadata.

Source code and unsigned candidates stay in this repository. Do not submit ordinary plugin source to `t8y2/dbx`; that repository accepts plugin host, SDK, CLI, schema, documentation, and official-example changes.
