# OVO Link Reader MCP · Cloudflare Workers

这是给 OVO 手机端使用的远程 MCP，不需要用户安装 Node、Termux 或 iSH。

## 现在只有一个工具

`read_social_link`

用途：读取公开链接内容，并自动识别豆瓣 / 小红书 / 抖音 / 普通网页。

- 普通 `fetch` 优先，节省 Browser Run 用量。
- 小红书、抖音或普通抓取内容明显不足时，`browser=auto` 会尝试 Cloudflare Browser Run 的 `markdown` Quick Action。
- 只读取公开页面，不登录账号，不绕过验证码或站点访问控制。
- 支持短链接跟随跳转。
- 限制本机、局域网、内部地址，降低 SSRF 风险。

## 部署后地址

假设 Worker 地址是：

`https://ovo-link-reader-mcp.<你的子域>.workers.dev`

那么：

- 健康检查：`https://ovo-link-reader-mcp.<你的子域>.workers.dev/health`
- MCP 地址：`https://ovo-link-reader-mcp.<你的子域>.workers.dev/mcp`

OVO 的「远程 MCP 协议服务」里填 `/mcp` 这个地址。

## 最省事部署方式：GitHub + Cloudflare

1. 把本项目整个文件夹上传到一个 GitHub 仓库。
2. Cloudflare Dashboard → Workers & Pages → Create → Import a repository。
3. 选择刚才的仓库。
4. 构建/部署使用项目里的 Wrangler 配置；如果 Cloudflare 询问部署命令，填写 `npx wrangler deploy`。
5. 第一次部署后检查 Worker 的 Settings / Bindings 中是否存在 Browser binding：`BROWSER`。
6. 打开 `https://你的-worker.workers.dev/health`，看到 `"ok": true` 即部署正常。
7. 在 OVO 里连接 `https://你的-worker.workers.dev/mcp`。

## 本地命令部署

需要 Node.js：

```bash
npm install
npx wrangler login
npm run deploy
```

本地远程模式测试：

```bash
npm run dev
```

## 工具参数

```json
{
  "url": "https://example.com",
  "max_chars": 16000,
  "browser": "auto"
}
```

`browser`：

- `auto`：普通读取不足时自动使用 Browser Run（推荐）
- `never`：只用普通 fetch
- `always`：始终用 Browser Run 渲染

## 现实限制

小红书和抖音可能根据地区、风控、登录状态或反机器人策略只返回部分公开内容。Browser Run 是正常浏览器渲染能力，不会绕过验证码或访问控制，因此不能承诺所有链接都能读到完整正文/评论。

当前版本重点验证：**OVO 手机端 → Streamable HTTP MCP → Cloudflare Worker → 读取公开链接** 这条链路。


## 0.2.2

- 为 OVO 浏览器/PWA 客户端增加显式 CORS 预检支持。
- `/mcp` 支持 `OPTIONS`，暴露 MCP 会话相关响应头。
- 允许部分 WebView/PWA 使用的 `Origin: null`。
- 这个 ZIP 内的 `package.json`、`wrangler.jsonc`、`src/` 已直接位于压缩包根目录，上传 GitHub 时不要再额外套文件夹。


## 0.2.2 CORS 修复
- 显式支持 `Origin: null`（file:// / 部分 WebView 测试环境）。
- 所有 OPTIONS 请求最先返回 CORS 预检响应。
- 回显浏览器请求的 Access-Control-Request-Headers。
- 增加 `/cors-test` 调试入口和 `X-OVO-Link-Reader-Version` 响应头。

部署时 Cloudflare Root directory 必须指向本包的 `package.json` 所在目录；若文件上传在仓库根目录，则 Root directory 留空或设为 `/`。
