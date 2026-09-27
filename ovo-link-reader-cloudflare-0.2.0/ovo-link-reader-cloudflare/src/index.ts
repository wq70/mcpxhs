import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type BrowserBinding = {
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
};

interface Env {
  BROWSER: BrowserBinding;
}

type LinkResult = {
  ok: boolean;
  platform: "douban" | "xiaohongshu" | "douyin" | "web";
  requested_url: string;
  final_url: string;
  title: string;
  author: string;
  published_at: string;
  description: string;
  content: string;
  images: string[];
  extraction: "fetch" | "browser" | "fetch+browser";
  warning?: string;
};

const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

function platformFromUrl(raw: string): LinkResult["platform"] {
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

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("链接格式不正确");
  }
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

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function cleanText(text: string): string {
  return decodeEntities(text)
    .replace(/\r/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstMatch(html: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return cleanText(m[1]);
  }
  return "";
}

function meta(html: string, key: string): string {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return firstMatch(html, [
    new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${esc}["'][^>]*>`, "i"),
  ]);
}

function extractImages(html: string): string[] {
  const out = new Set<string>();
  for (const re of [
    /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/gi,
    /<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.size < 12) {
      const v = decodeEntities(m[1]);
      if (/^https?:\/\//i.test(v)) out.add(v);
    }
  }
  return [...out];
}

function stripHtml(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(br|\/p|\/div|\/article|\/section|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return cleanText(withoutNoise);
}

function looksBlocked(text: string): boolean {
  const low = text.toLowerCase();
  return (
    text.length < 400 ||
    low.includes("captcha") ||
    low.includes("access denied") ||
    low.includes("verify you are human") ||
    text.includes("安全验证") ||
    text.includes("访问过于频繁") ||
    text.includes("请完成验证") ||
    text.includes("登录后查看")
  );
}

async function fetchPage(url: string): Promise<{ finalUrl: string; html: string; contentType: string }> {
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
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) throw new Error(`目标页面返回 HTTP ${response.status}`);
  const html = await response.text();
  return { finalUrl, html, contentType };
}

function extractBasic(html: string, finalUrl: string, maxChars: number) {
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
  const published =
    meta(html, "article:published_time") ||
    meta(html, "date") ||
    firstMatch(html, [/"datePublished"\s*:\s*"([^"]+)"/i]);
  const description = meta(html, "og:description") || meta(html, "description");
  const body = stripHtml(html);
  const content = body.slice(0, maxChars);
  return {
    title,
    author,
    published_at: published,
    description,
    content,
    images: extractImages(html),
    canonical:
      meta(html, "og:url") ||
      firstMatch(html, [/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i]) ||
      finalUrl,
  };
}

async function browserMarkdown(env: Env, url: string, maxChars: number): Promise<string> {
  const response = await env.BROWSER.quickAction("markdown", {
    url,
    userAgent: UA,
    gotoOptions: { waitUntil: "networkidle2" },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Browser Run 返回 HTTP ${response.status}: ${detail}`);
  }
  const payload = (await response.json()) as { success?: boolean; result?: unknown; errors?: unknown };
  if (!payload.success || typeof payload.result !== "string") {
    throw new Error(`Browser Run 未返回可读正文: ${JSON.stringify(payload.errors ?? payload).slice(0, 500)}`);
  }
  return cleanText(payload.result).slice(0, maxChars);
}

async function readLink(env: Env, rawUrl: string, maxChars: number, browser: "auto" | "never" | "always"): Promise<LinkResult> {
  const requested = assertSafeUrl(rawUrl).toString();
  const initialPlatform = platformFromUrl(requested);

  let basic: ReturnType<typeof extractBasic> | null = null;
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

  const platform = platformFromUrl(finalUrl || requested) || initialPlatform;
  const fetchText = basic?.content || "";
  const shouldUseBrowser =
    browser === "always" ||
    (browser === "auto" && (!basic || looksBlocked(fetchText) || ["xiaohongshu", "douyin"].includes(platform)));

  let browserText = "";
  let browserError = "";
  if (shouldUseBrowser) {
    try {
      browserText = await browserMarkdown(env, finalUrl, maxChars);
    } catch (error) {
      browserError = error instanceof Error ? error.message : String(error);
    }
  }

  const content = browserText || fetchText;
  const extraction: LinkResult["extraction"] = browserText
    ? basic
      ? "fetch+browser"
      : "browser"
    : "fetch";

  if (!content) {
    throw new Error(
      [fetchError && `普通读取失败：${fetchError}`, browserError && `浏览器读取失败：${browserError}`]
        .filter(Boolean)
        .join("；") || "没有读取到公开内容",
    );
  }

  const warnings: string[] = [];
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
    extraction,
    ...(warnings.length ? { warning: warnings.join("；") } : {}),
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "ovo-link-reader",
    version: "0.2.0",
  });

  server.registerTool(
    "read_social_link",
    {
      description:
        "读取公开网页链接内容。针对豆瓣、小红书、抖音做平台识别，并在普通抓取不足时使用 Cloudflare Browser Run 渲染公开页面。不会登录账号或绕过验证码。",
      inputSchema: {
        url: z.string().url().describe("要读取的公开 http/https 链接"),
        max_chars: z.number().int().min(1000).max(30000).default(16000).optional(),
        browser: z.enum(["auto", "never", "always"]).default("auto").optional(),
      },
    },
    async ({ url, max_chars, browser }) => {
      try {
        const result = await readLink(env, url, max_chars ?? 16000, browser ?? "auto");
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `链接读取失败：${message}` }],
        };
      }
    },
  );

  return server;
}

function validBrowserOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        name: "ovo-link-reader",
        version: "0.2.0",
        mcp: `${url.origin}/mcp`,
        tool: "read_social_link",
      });
    }

    if (!validBrowserOrigin(request)) {
      return new Response("Invalid Origin", { status: 403 });
    }

    const handler = createMcpHandler(() => createServer(env), {
      route: "/mcp",
      corsOptions: { origin: "*" },
      allowedOriginHostnames: "*",
      responseMode: "auto",
    });

    return handler(request, env, ctx);
  },
};
