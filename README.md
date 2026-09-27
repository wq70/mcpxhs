# OVO Link Reader MCP 0.3.0

这是给 OVO 移动端/网页端使用的 Cloudflare Workers 远程 MCP。

本版为了排除 SDK/适配层导致的 500，直接实现 OVO 当前需要的 MCP Streamable HTTP JSON-RPC 子集：

- initialize
- notifications/initialized
- tools/list
- tools/call
- ping
- resources/list（空）
- resources/templates/list（空）
- prompts/list（空）

并保留：

- 豆瓣 / 小红书 / 抖音 / 普通网页公开内容读取
- Cloudflare Browser Run 动态页面兜底
- file:// / Origin: null CORS 支持
- MCP Session ID 响应头

## 部署

将本目录内容直接放在 GitHub 仓库根目录，Cloudflare Build Root directory 使用 `/` 或留空，Deploy command：

```text
npx wrangler deploy
```

部署后先访问：

```text
https://你的域名/health
```

确认 version 为 0.3.0。

OVO 端点：

```text
https://你的域名/mcp
```
