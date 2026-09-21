# NintyAPI — DBX Plugin

在 DBX 中调试 HTTP 接口的插件：类似 Apifox/Postman 的工作台，支持接口集合管理、请求历史、cURL 导入导出。

A DBX plugin that turns the workbench into an API debugging client: organize requests into collections, send HTTP requests through the Go backend, and inspect status/timing/headers/body responses.

## 来源说明 / Provenance

本项目的初始骨架起步于 [eryajf/dbx-plugin-k8s](https://github.com/eryajf/dbx-plugin-k8s)（Apache-2.0）。此后以 AI 辅助进行了全面重写：当前仓库中的全部代码均为本项目自己的实现，不含来自上游的原创表达，功能方向也不同（HTTP API 调试客户端）。在此感谢原项目在起步阶段的参考价值。

NintyAPI started from the plugin skeleton of [eryajf/dbx-plugin-k8s](https://github.com/eryajf/dbx-plugin-k8s) (Apache-2.0) and has since been fully rewritten with AI assistance. All code in this repository is this project's own implementation and contains none of the upstream's original expression; the original project is credited here for provenance.

## 功能

- **接口集合**：目录 + 请求的树形结构，按连接（项目）持久化，支持新建/重命名/级联删除
- **请求编辑器**：方法 + URL + Params / Headers / Body / Auth（Bearer、Basic）/ 设置（超时、跟随重定向、TLS 校验）。请求体类型共 7 种，标签统一用协议名（与 Postman/Apifox 一致，中英文界面下都不翻译，悬停显示对应的 Content-Type）：`none`、`JSON`、`XML`、`raw`、`x-www-form-urlencoded`、`form-data`、`binary`
- **文件上传**：form-data 的每一行可切换「文本 / 文件」，一个**文件行可以装多个文件**（一次多选或多次拖入追加），发送时展开成多个同名 part——与浏览器 `<input type="file" multiple>` 的请求体完全一致；binary 请求体可直接选一个文件。文件内容按 512 KiB 分片流式传给后端再发出，单文件上限 64 MiB。也可以直接填写路径（见下）
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
| `upload/begin` | 声明一个待上传文件（名称/类型/大小），返回 `uploadId`；超过 64 MiB 或大小为负会被拒绝 |
| `upload/chunk` | 按偏移写入一片 base64 分片；分片必须顺序到达，累计超过上限即拒绝 |
| `upload/abort` | 放弃一次上传并删除已落盘的临时文件 |
| `clipboard/read-text` | 读取系统剪贴板文本（插件 UI 位于沙箱 iframe，浏览器剪贴板 API 不可用） |
| `clipboard/write-text` | 写入系统剪贴板文本（`host.copy` 与浏览器 API 均不可用时的兜底） |
| `ui/preferences-get` / `set` | UI 偏好（前端 localStorage 桥接） |

## 文件上传是怎么走的

插件 UI 跑在 DBX 的沙箱 iframe 里（`sandbox="allow-scripts"`，独立源），后端是另一个进程，两者之间只有 JSON-RPC。这带来两个约束，也决定了上面的接口形状：

1. **浏览器选中的文件没有磁盘路径**，只有字节，所以后端不可能靠路径去读它；
2. **桥接的单条 JSON 参数上限 2 MiB**，整个文件塞不进一次调用。

于是：UI 把文件切成 512 KiB 的分片（base64 后约 683 KiB，留足余量），依次 `upload/begin` → `upload/chunk`，后端 `internal/upload` 把分片按偏移写进临时目录并校验顺序；发送请求时 `http/request` 的 body 里带上 `uploadId`，后端再把文件作为 multipart part 或二进制体发出。上传在**发送时才发生**，所以挑选文件本身不会产生任何网络或磁盘写入；临时文件 30 分钟未被使用即自动清理，请求失败时会主动 `upload/abort`。

三种指定文件的方式，按优先级：

- **选择文件**：点「选择文件」按钮走系统文件对话框，可一次选多个；
- **拖拽**：把文件拖到文件行或 binary 的按钮上，可一次拖多个——拖放事件不依赖任何权限，如果宿主沙箱不允许弹系统对话框，这条路仍然可用；
- **填写路径**：binary 请求体的「文件路径」输入框，以及 form-data 里把行切成「文本」后写 `@/绝对/路径`。路径由**运行 DBX 的那台机器**解析，适合文件和 DBX 同机、或从 cURL 导入的场景。

多选时，选中的文件都进入**同一行**，共用该行的字段名；行内每个文件是一个可单独删除的小标签，另有「＋」继续追加（从不同目录分批添加时不必一次选全）。发送时这一行展开成多个同名 part，顺序与添加顺序一致。binary 请求体只接受一个文件（一个请求体只能是一份字节）。

后端 `FormField` 用 `files` 数组表达这一行；早期版本存的单个 `file` 对象仍然读得懂，cURL 里手写的 `@路径` 也会被归一化成同一个形状。

### 两种表单编码不能互换文件

`x-www-form-urlencoded` 按协议就无法携带文件，所以：

- **切换不会丢文件**。从 `form-data` 切到 `x-www-form-urlencoded` 时，行里的文件原样保留（表格上方会显示「此编码无法携带文件，下面 N 个文件不会被发送」，对应行也会标注），切回 `form-data` 即可继续使用。此前这一步会把文件行压成空文本行，改一格就永久丢失。
- **发送会被拦下**，而不是悄悄丢掉文件。前端在发送前就报错（不会白上传一遍），后端作为最后一道防线也会拒绝，两边给出同样的提示：请改用 `form-data`，或移除该字段的文件。空着没选文件的文件行不算，它本来就没什么可丢。

保存到接口集合或历史时只保留文件名（以及路径），**不保留上传凭据**——上传是会话级的。因此重新打开一个保存过的请求，文件行会显示「需重新选择」，需要再选一次文件才能发送；这是浏览器沙箱的固有限制，不是可以绕过的实现细节。

### 从浏览器复制的 cURL

浏览器 DevTools「Copy as cURL」导出的 multipart 请求（`--data-raw $'...'` 那种）可以直接粘贴导入：解析器会识别 ANSI-C 引号、shell 行续接和 multipart 边界，把它还原成 form-data 行——文本字段原样保留，文件部分还原成带文件名和 Content-Type 的文件行。同时**丢弃复制过来的 `Content-Type` 头**，因为发送时会重新生成边界，旧边界指向的分隔符根本不会出现在请求体里。

但要注意：**DevTools 从不复制文件内容**，导出的 curl 里文件部分是空的。所以导入后必须重新选一次文件，任何工具都无法从这段 curl 里恢复文件字节——不重新选就会发出一个 0 字节文件。插件不会静默这么做，会直接拒绝发送并提示选择文件。

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
