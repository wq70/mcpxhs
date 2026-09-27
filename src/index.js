const VERSION = "0.3.0";
const SERVER_NAME = "ovo-link-reader";
const SUPPORTED_PROTOCOLS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

function platformFromUrl(raw) {
  const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  if (host === "douban.com" || host.endsWith(".douban.com")) return "douban";
  if (
    host === "xiaohongshu.com" ||
    host.endsWith(".xiaohongshu.com") ||
    host === "xhslink.com" ||
    host.endsWith(".xhslink.com")
  ) return "xiaohongshu";
  if (
    host === "douyin.com" ||
    host.endsWith(".douyin.com") ||
    host === "iesdouyin.com" ||
    host.endsWith(".iesdouyin.com") ||
    host === "v.douyin.com"
  ) return "douyin";
  return "web";
}

function isPrivateIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); }
  catch { throw new Error("链接格式不正确"); }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("只支持 http/https 链接");
  }

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    isPrivateIpv4(host)
  ) {
    throw new Error("不允许读取本机、局域网或内部服务地址");
  }
  return u;
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(text || "")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function cleanText(text) {
  return decodeEntities(text)
    .replace(/\r/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return cleanText(m[1]);
  }
  return "";
}

function meta(html, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return firstMatch(html, [
    new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${esc}["'][^>]*>`, "i"),
  ]);
}

function extractImages(html) {
  const out = new Set();
  for (const re of [
    /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/gi,
    /<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi,
  ]) {
    let m;
    while ((m = re.exec(html)) && out.size < 12) {
      const v = decodeEntities(m[1]);
      if (/^https?:\/\//i.test(v)) out.add(v);
    }
  }
  return [...out];
}

function stripHtml(html) {
  return cleanText(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<(br|\/p|\/div|\/article|\/section|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
}

function looksBlocked(text) {
  const low = String(text || "").toLowerCase();
  return (
    String(text || "").length < 400 ||
    low.includes("captcha") ||
    low.includes("access denied") ||
    low.includes("verify you are human") ||
    String(text || "").includes("安全验证") ||
    String(text || "").includes("访问过于频繁") ||
    String(text || "").includes("请完成验证") ||
    String(text || "").includes("登录后查看")
  );
}

async function fetchPage(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
    },
    signal: AbortSignal.timeout(12000),
  });

  const finalUrl = response.url || url;
  assertSafeUrl(finalUrl);
  if (!response.ok) throw new Error(`目标页面返回 HTTP ${response.status}`);
  return { finalUrl, html: await response.text() };
}

function extractBasic(html, finalUrl, maxChars) {
  const title =
    meta(html, "og:title") ||
    meta(html, "twitter:title") ||
    firstMatch(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]);

  const author =
    meta(html, "author") ||
    meta(html, "article:author") ||
    firstMatch(html, [
      /"author"\s*:\s*{[^}]*"name"\s*:\s*"([^"]+)"/i,
      /"author"\s*:\s*"([^"]+)"/i,
    ]);

  const publishedAt =
    meta(html, "article:published_time") ||
    meta(html, "date") ||
    firstMatch(html, [/"datePublished"\s*:\s*"([^"]+)"/i]);

  return {
    title,
    author,
    published_at: publishedAt,
    description: meta(html, "og:description") || meta(html, "description"),
    content: stripHtml(html).slice(0, maxChars),
    images: extractImages(html),
    canonical:
      meta(html, "og:url") ||
      firstMatch(html, [/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i]) ||
      finalUrl,
  };
}

async function browserMarkdown(env, url, maxChars) {
  if (!env?.BROWSER?.quickAction) throw new Error("Cloudflare Browser Run 未绑定");
  const response = await env.BROWSER.quickAction("markdown", {
    url,
    userAgent: UA,
    gotoOptions: { waitUntil: "networkidle2" },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Browser Run 返回 HTTP ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  if (!payload?.success || typeof payload.result !== "string") {
    throw new Error(`Browser Run 未返回可读正文: ${JSON.stringify(payload?.errors ?? payload).slice(0, 500)}`);
  }
  return cleanText(payload.result).slice(0, maxChars);
}

async function readLink(env, rawUrl, maxChars = 16000, browser = "auto") {
  const requested = assertSafeUrl(rawUrl).toString();
  let basic = null;
  let finalUrl = requested;
  let fetchError = "";

  if (browser !== "always") {
    try {
      const page = await fetchPage(requested);
      finalUrl = page.finalUrl;
      basic = extractBasic(page.html, finalUrl, maxChars);
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
    }
  }

  const platform = platformFromUrl(finalUrl || requested);
  const fetchText = basic?.content || "";
  const shouldUseBrowser =
    browser === "always" ||
    (browser === "auto" && (!basic || looksBlocked(fetchText) || ["xiaohongshu", "douyin"].includes(platform)));

  let browserText = "";
  let browserError = "";
  if (shouldUseBrowser) {
    try { browserText = await browserMarkdown(env, finalUrl, maxChars); }
    catch (error) { browserError = error instanceof Error ? error.message : String(error); }
  }

  const content = browserText || fetchText;
  if (!content) {
    throw new Error(
      [fetchError && `普通读取失败：${fetchError}`, browserError && `浏览器读取失败：${browserError}`]
        .filter(Boolean)
        .join("；") || "没有读取到公开内容"
    );
  }

  const warnings = [];
  if (browserError && basic) warnings.push(`浏览器兜底失败，已返回普通抓取结果：${browserError}`);
  if (looksBlocked(content)) warnings.push("页面可能只返回了验证页、登录页或不完整公开内容");

  return {
    ok: true,
    platform,
    requested_url: requested,
    final_url: finalUrl,
    title: basic?.title || "",
    author: basic?.author || "",
    published_at: basic?.published_at || "",
    description: basic?.description || "",
    content,
    images: basic?.images || [],
    extraction: browserText ? (basic ? "fetch+browser" : "browser") : "fetch",
    ...(warnings.length ? { warning: warnings.join("；") } : {}),
  };
}

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  const requestedHeaders = request.headers.get("access-control-request-headers");
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", origin || "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  h.set(
    "Access-Control-Allow-Headers",
    requestedHeaders || "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, X-MCP-Pairing-Code"
  );
  h.set("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version, X-OVO-Link-Reader-Version");
  h.set("Access-Control-Max-Age", "86400");
  h.set("Cache-Control", "no-store");
  h.set("X-OVO-Link-Reader-Version", VERSION);
  h.append("Vary", "Origin");
  h.append("Vary", "Access-Control-Request-Headers");
  return h;
}

function withCors(request, response, extraHeaders) {
  const headers = new Headers(response.headers);
  corsHeaders(request).forEach((value, key) => headers.set(key, value));
  if (extraHeaders) {
    Object.entries(extraHeaders).forEach(([k, v]) => headers.set(k, String(v)));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonRpcResponse(request, id, result, extraHeaders) {
  return withCors(
    request,
    Response.json({ jsonrpc: "2.0", id: id ?? null, result }),
    extraHeaders
  );
}

function jsonRpcError(request, id, code, message, data, status = 200) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return withCors(
    request,
    Response.json({ jsonrpc: "2.0", id: id ?? null, error }, { status })
  );
}

const TOOL_DEFINITION = {
  name: "read_social_link",
  title: "读取公开链接",
  description: "读取公开网页链接内容，针对豆瓣、小红书、抖音做平台识别；普通抓取不足时尝试 Cloudflare Browser Run 渲染。不会登录账号或绕过验证码。",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", format: "uri", description: "要读取的公开 http/https 链接" },
      max_chars: { type: "integer", minimum: 1000, maximum: 30000, default: 16000 },
      browser: { type: "string", enum: ["auto", "never", "always"], default: "auto" }
    },
    required: ["url"],
    additionalProperties: false
  },
  annotations: {
    title: "读取公开链接",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  }
};

async function handleMcpPost(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonRpcError(request, null, -32700, "Parse error", undefined, 400); }

  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(request, body?.id ?? null, -32600, "Invalid Request", undefined, 400);
  }

  const { id, method, params } = body;

  // Notifications have no id. OVO expects 202 for notifications/initialized.
  if (method === "notifications/initialized") {
    return withCors(request, new Response(null, { status: 202 }));
  }

  if (method === "initialize") {
    const requestedVersion = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requestedVersion) ? requestedVersion : "2025-11-25";
    const sessionId = `ovo_${crypto.randomUUID()}`;
    return jsonRpcResponse(
      request,
      id,
      {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: SERVER_NAME,
          version: VERSION
        },
        instructions: "提供 read_social_link 工具，用于读取公开网页链接内容。"
      },
      {
        "Mcp-Session-Id": sessionId,
        "MCP-Protocol-Version": protocolVersion
      }
    );
  }

  if (method === "ping") {
    return jsonRpcResponse(request, id, {});
  }

  if (method === "tools/list") {
    return jsonRpcResponse(request, id, { tools: [TOOL_DEFINITION] });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name !== "read_social_link") {
      return jsonRpcError(request, id, -32602, `未知工具：${String(name || "")}`);
    }
    if (!args.url || typeof args.url !== "string") {
      return jsonRpcResponse(request, id, {
        isError: true,
        content: [{ type: "text", text: "链接读取失败：缺少 url 参数" }]
      });
    }

    const maxChars = Number.isFinite(Number(args.max_chars))
      ? Math.max(1000, Math.min(30000, Math.trunc(Number(args.max_chars))))
      : 16000;
    const browser = ["auto", "never", "always"].includes(args.browser) ? args.browser : "auto";

    try {
      const result = await readLink(env, args.url, maxChars, browser);
      return jsonRpcResponse(request, id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonRpcResponse(request, id, {
        isError: true,
        content: [{ type: "text", text: `链接读取失败：${message}` }]
      });
    }
  }

  // Compatibility fallbacks for clients that probe these despite only tools being declared.
  if (method === "resources/list") return jsonRpcResponse(request, id, { resources: [] });
  if (method === "resources/templates/list") return jsonRpcResponse(request, id, { resourceTemplates: [] });
  if (method === "prompts/list") return jsonRpcResponse(request, id, { prompts: [] });
  if (method === "logging/setLevel") return jsonRpcResponse(request, id, {});

  if (id === undefined || id === null) {
    return withCors(request, new Response(null, { status: 202 }));
  }
  return jsonRpcError(request, id, -32601, `Method not found: ${method}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return withCors(
        request,
        Response.json({
          ok: true,
          name: SERVER_NAME,
          version: VERSION,
          transport: "streamable-http-jsonrpc",
          mcp: `${url.origin}/mcp`,
          tool: "read_social_link",
          browser_binding: Boolean(env?.BROWSER)
        })
      );
    }

    if (url.pathname === "/cors-test") {
      return withCors(
        request,
        Response.json({
          ok: true,
          version: VERSION,
          origin: request.headers.get("origin"),
          requested_headers: request.headers.get("access-control-request-headers") || ""
        })
      );
    }

    if (url.pathname !== "/mcp") {
      return withCors(request, new Response("Not found", { status: 404 }));
    }

    if (request.method === "POST") {
      try {
        return await handleMcpPost(request, env);
      } catch (error) {
        console.error("[OVO Link Reader] MCP POST error", error);
        return jsonRpcError(
          request,
          null,
          -32603,
          "Internal server error",
          { message: error instanceof Error ? error.message : String(error), version: VERSION },
          500
        );
      }
    }

    // OVO opens GET only when a session id exists. This server is stateless and
    // intentionally does not provide an event stream; OVO treats 405 as supported fallback.
    if (request.method === "GET") {
      return withCors(request, new Response("Event stream not enabled", { status: 405 }));
    }

    if (request.method === "DELETE") {
      return withCors(request, new Response(null, { status: 204 }));
    }

    return withCors(request, new Response("Method not allowed", { status: 405 }));
  }
};
