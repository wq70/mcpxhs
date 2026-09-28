# OVO Link Reader MCP 0.4.0

目标：用户在 OVO 聊天里发送公开社交平台链接，角色拿到真实正文后再正常讨论。

## 小红书读取策略

1. 先解析 `xhslink.cn / xhslink.com` 分享短链。
2. 尝试读取小红书公开页面内的 `window.__INITIAL_STATE__`，直接提取结构化笔记：标题、正文、作者、图片、标签、互动量。
3. 如果 Cloudflare 数据中心 IP 被小红书风控，且配置了 `TIKHUB_API_KEY`，自动使用 TikHub App V2 `get_image_note_detail` 读取真实笔记数据。
4. 安全验证页 / 登录页不会再作为成功结果返回给模型。

> 仅靠 Cloudflare Browser Run 无法保证读取小红书：小红书可能直接把 Cloudflare 数据中心 IP 导向安全验证。要给大量移动端用户稳定使用，建议配置 TikHub API Key。

## 部署

将本压缩包内容直接放到 GitHub 仓库根目录，Cloudflare Worker 的 Root directory 使用 `/` 或留空。

健康检查：

`https://你的-worker.workers.dev/health`

应看到：

- `version: 0.4.0`
- `xhs_ssr: true`
- `tikhub_configured: true/false`

## 配置 TikHub（稳定小红书读取）

Cloudflare → Worker → Settings → Variables and Secrets → Add：

- Name: `TIKHUB_API_KEY`
- Type: Secret
- Value: 你的 TikHub API Key

保存后重新部署。

MCP 地址仍然是：

`https://你的-worker.workers.dev/mcp`
