const VERSION = "0.4.0";
const SERVER_NAME = "ovo-link-reader";
const SUPPORTED_PROTOCOLS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
const MOBILE_UA =
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
    host.endsWith(".xhslink.com") ||
    host === "xhslink.cn" ||
    host.endsWith(".xhslink.cn")
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
    while ((m = re.exec(html)) && out.size < 16) {
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
  const value = String(text || "");
  const low = value.toLowerCase();
  return (
    value.length < 160 ||
    low.includes("captcha") ||
    low.includes("access denied") ||
    low.includes("verify you are human") ||
    value.includes("安全验证") ||
    value.includes("访问过于频繁") ||
    value.includes("请完成验证") ||
    value.includes("登录后查看") ||
    value.includes("当前笔记暂时无法浏览")
  );
}

function isXhsCaptchaUrl(raw) {
  try {
    const u = new URL(raw);
    return u.hostname.endsWith("xiaohongshu.com") && /website-login\/captcha|login/i.test(u.pathname);
  } catch { return false; }
}

async function resolveRedirectChain(rawUrl, maxHops = 6) {
  let current = assertSafeUrl(rawUrl).toString();
  for (let i = 0; i < maxHops; i++) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": DESKTOP_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en,zh-CN;q=0.9,zh;q=0.8",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return current;
      const next = new URL(location, current).toString();
      assertSafeUrl(next);
      current = next;
      continue;
    }
    return current;
  }
  return current;
}

async function fetchPage(url, { ua = MOBILE_UA, redirect = "follow" } = {}) {
  const response = await fetch(url, {
    redirect,
    headers: {
      "user-agent": ua,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
    },
    signal: AbortSignal.timeout(15000),
  });

  const finalUrl = response.url || url;
  assertSafeUrl(finalUrl);
  if (!response.ok) throw new Error(`目标页面返回 HTTP ${response.status}`);
  return { finalUrl, html: await response.text(), response };
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

function scanJsObject(source, startIndex) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) { inString = false; quote = ""; }
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }
  return "";
}

function sanitizeJsObject(text) {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  const tokens = ["-Infinity", "undefined", "Infinity", "NaN"];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) { inString = false; quote = ""; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    let matched = false;
    for (const token of tokens) {
      if (text.startsWith(token, i)) {
        out += "null";
        i += token.length - 1;
        matched = true;
        break;
      }
    }
    if (!matched) out += ch;
  }
  return out;
}

function extractXhsInitialState(html) {
  const markers = ["window.__INITIAL_STATE__", "window.__INITIAL_STATE__ =", "window.__INITIAL_STATE__="];
  let markerIndex = -1;
  let marker = "";
  for (const candidate of markers) {
    markerIndex = html.indexOf(candidate);
    if (markerIndex >= 0) { marker = candidate; break; }
  }
  if (markerIndex < 0) return null;

  let start = markerIndex + marker.length;
  while (start < html.length && /[\s=]/.test(html[start])) start++;
  if (html[start] !== "{") return null;
  const raw = scanJsObject(html, start);
  if (!raw) return null;
  try { return JSON.parse(sanitizeJsObject(raw)); }
  catch { return null; }
}

function unwrapMaybe(value) {
  if (!value || typeof value !== "object") return value;
  for (const key of ["_value", "value", "data"]) {
    if (value[key] && typeof value[key] === "object" && Object.keys(value).length <= 3) return value[key];
  }
  return value;
}

function firstString(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if ((typeof value === "number" || typeof value === "bigint") && String(value)) return String(value);
  }
  return "";
}

function firstNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return 0;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  }
  return 0;
}

function imageUrlsFromNote(note) {
  const list = note?.imageList || note?.image_list || note?.images || [];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item === "string") { if (/^https?:\/\//.test(item)) out.push(item); continue; }
    if (!item || typeof item !== "object") continue;
    const direct = firstString(item, ["urlDefault", "url_default", "url", "urlPre", "url_pre", "masterUrl", "master_url"]);
    if (direct && /^https?:\/\//.test(direct)) out.push(direct);
    const info = item.infoList || item.info_list;
    if (Array.isArray(info)) {
      for (const sub of info) {
        const u = firstString(sub, ["url", "urlDefault", "url_default"]);
        if (u && /^https?:\/\//.test(u)) out.push(u);
      }
    }
  }
  return [...new Set(out)].slice(0, 20);
}

function tagsFromNote(note) {
  const list = note?.tagList || note?.tag_list || note?.tags || [];
  if (!Array.isArray(list)) return [];
  return list.map((item) => typeof item === "string" ? item : firstString(item, ["name", "title", "tag_name", "tagName"]))
    .filter(Boolean).slice(0, 30);
}

function normalizeXhsNote(note, finalUrl, extraction) {
  note = unwrapMaybe(note) || {};
  const user = unwrapMaybe(note.user || note.author || note.userInfo || note.user_info) || {};
  const interact = unwrapMaybe(note.interactInfo || note.interact_info || note.interact || {}) || {};
  const title = firstString(note, ["title", "displayTitle", "display_title", "name"]);
  const desc = firstString(note, ["desc", "content", "description", "noteText", "note_text", "text"]);
  const noteId = firstString(note, ["noteId", "note_id", "id", "sourceNoteId", "source_note_id"]);
  const type = firstString(note, ["type", "noteType", "note_type"]);
  const publishedRaw = firstNumber(note, ["time", "createTime", "create_time", "publishTime", "publish_time"]);
  const publishedAt = publishedRaw
    ? new Date(publishedRaw < 1e12 ? publishedRaw * 1000 : publishedRaw).toISOString()
    : firstString(note, ["publishedAt", "published_at", "date"]);
  const images = imageUrlsFromNote(note);
  const tags = tagsFromNote(note);
  const author = firstString(user, ["nickname", "nickName", "name", "userName", "user_name"]);
  const authorId = firstString(user, ["userId", "user_id", "id"]);
  const likes = firstString(interact, ["likedCount", "liked_count", "likeCount", "like_count"]);
  const collects = firstString(interact, ["collectedCount", "collected_count", "collectCount", "collect_count"]);
  const comments = firstString(interact, ["commentCount", "comment_count", "commentsCount", "comments_count"]);
  const shares = firstString(interact, ["shareCount", "share_count", "sharedCount", "shared_count"]);

  return {
    ok: Boolean(title || desc),
    platform: "xiaohongshu",
    requested_url: finalUrl,
    final_url: finalUrl,
    note_id: noteId,
    note_type: type,
    title,
    author,
    author_id: authorId,
    published_at: publishedAt,
    description: desc,
    content: desc,
    tags,
    images,
    stats: { likes, collects, comments, shares },
    extraction,
  };
}

function findXhsNoteInState(state) {
  const root = unwrapMaybe(state) || {};
  const noteRoot = unwrapMaybe(root.note) || {};
  let map = unwrapMaybe(noteRoot.noteDetailMap || noteRoot.note_detail_map);
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const entry of Object.values(map)) {
      const unwrapped = unwrapMaybe(entry);
      const candidate = unwrapMaybe(unwrapped?.note || unwrapped?.noteCard || unwrapped?.note_card || unwrapped);
      if (candidate && typeof candidate === "object") {
        const desc = firstString(candidate, ["desc", "content", "description", "noteText", "note_text"]);
        const title = firstString(candidate, ["title", "displayTitle", "display_title"]);
        if (desc || title) return candidate;
      }
    }
  }

  const seen = new Set();
  let best = null;
  let bestScore = 0;
  function visit(value, depth) {
    if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) return;
    seen.add(value);
    const obj = unwrapMaybe(value);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      let score = 0;
      if (firstString(obj, ["desc", "content", "noteText", "note_text"])) score += 5;
      if (firstString(obj, ["title", "displayTitle", "display_title"])) score += 3;
      if (firstString(obj, ["noteId", "note_id", "sourceNoteId", "source_note_id"])) score += 3;
      if (obj.user || obj.userInfo || obj.user_info) score += 2;
      if (obj.imageList || obj.image_list || obj.video) score += 2;
      if (obj.interactInfo || obj.interact_info) score += 1;
      if (score > bestScore) { best = obj; bestScore = score; }
      for (const child of Object.values(obj)) visit(child, depth + 1);
    } else if (Array.isArray(obj)) {
      for (const child of obj) visit(child, depth + 1);
    }
  }
  visit(root, 0);
  return bestScore >= 6 ? best : null;
}

async function readXhsViaSsr(rawUrl, maxChars) {
  const requested = assertSafeUrl(rawUrl).toString();
  let canonical = requested;
  try { canonical = await resolveRedirectChain(requested); } catch { /* keep requested */ }

  // If a short-link resolves directly to a captcha URL, keep the original share link
  // for provider fallback, but do not mistake the captcha page for note content.
  if (isXhsCaptchaUrl(canonical)) {
    throw new Error("小红书公开页面被风控重定向到安全验证");
  }

  const page = await fetchPage(canonical, { ua: DESKTOP_UA, redirect: "manual" });
  if (page.response.status >= 300 && page.response.status < 400) {
    const location = page.response.headers.get("location") || "";
    if (/captcha|login/i.test(location)) throw new Error("小红书公开页面被风控重定向到安全验证");
    throw new Error(`小红书公开页面发生重定向：${page.response.status}`);
  }
  const state = extractXhsInitialState(page.html);
  if (!state) throw new Error("小红书页面没有公开 SSR 笔记数据");
  const note = findXhsNoteInState(state);
  if (!note) throw new Error("小红书 SSR 数据里没有找到笔记正文");
  const normalized = normalizeXhsNote(note, canonical, "xiaohongshu_ssr");
  normalized.requested_url = requested;
  normalized.content = cleanText(normalized.content).slice(0, maxChars);
  normalized.description = normalized.content;
  if (!normalized.content && !normalized.title) throw new Error("小红书 SSR 笔记正文为空");
  return normalized;
}

function deepWalkObjects(root, maxDepth = 10) {
  const out = [];
  const seen = new Set();
  function visit(value, depth) {
    if (!value || typeof value !== "object" || depth > maxDepth || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    out.push(value);
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(root, 0);
  return out;
}

function pickXhsNoteFromProvider(payload) {
  let best = null;
  let bestScore = 0;
  for (const obj of deepWalkObjects(payload)) {
    let score = 0;
    const desc = firstString(obj, ["desc", "content", "description", "note_text", "noteText"]);
    const title = firstString(obj, ["title", "display_title", "displayTitle"]);
    const id = firstString(obj, ["note_id", "noteId", "id"]);
    if (desc) score += 8;
    if (title) score += 4;
    if (id && /^[a-f0-9]{16,32}$/i.test(id)) score += 4;
    if (obj.user || obj.user_info || obj.userInfo) score += 2;
    if (obj.image_list || obj.imageList || obj.images) score += 2;
    if (obj.interact_info || obj.interactInfo) score += 1;
    if (score > bestScore) { best = obj; bestScore = score; }
  }
  return bestScore >= 8 ? best : null;
}

async function readXhsViaTikHub(env, rawUrl, maxChars) {
  const apiKey = String(env?.TIKHUB_API_KEY || "").trim();
  if (!apiKey) throw new Error("未配置 TIKHUB_API_KEY");

  const endpoint = new URL("https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_image_note_detail");
  endpoint.searchParams.set("share_text", rawUrl);
  const response = await fetch(endpoint.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": DESKTOP_UA,
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`TikHub 返回 HTTP ${response.status}: ${text.slice(0, 240)}`);
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error("TikHub 返回了无法解析的 JSON"); }

  if (payload?.code && Number(payload.code) !== 200) {
    throw new Error(`TikHub 返回业务错误 ${payload.code}: ${payload.message_zh || payload.message || "未知错误"}`);
  }
  const note = pickXhsNoteFromProvider(payload);
  if (!note) throw new Error(`TikHub 没有返回可识别的笔记正文${payload?.message_zh ? `：${payload.message_zh}` : ""}`);
  const result = normalizeXhsNote(note, rawUrl, "tikhub_app_v2");
  result.requested_url = rawUrl;
  result.final_url = firstString(note, ["note_url", "noteUrl", "url", "share_url", "shareUrl"]) || rawUrl;
  result.content = cleanText(result.content).slice(0, maxChars);
  result.description = result.content;
  result.provider_request_id = firstString(payload, ["request_id", "requestId"]);
  if (!result.content && !result.title) throw new Error("TikHub 返回的笔记正文为空");
  return result;
}

async function readXiaohongshu(env, rawUrl, maxChars) {
  const errors = [];
  try {
    const ssr = await readXhsViaSsr(rawUrl, maxChars);
    if (ssr.content || ssr.title) return ssr;
  } catch (error) {
    errors.push(`公开 SSR：${error instanceof Error ? error.message : String(error)}`);
  }

  if (env?.TIKHUB_API_KEY) {
    try {
      const provider = await readXhsViaTikHub(env, rawUrl, maxChars);
      if (provider.content || provider.title) return provider;
    } catch (error) {
      errors.push(`TikHub：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    errors.push("TikHub：未配置 TIKHUB_API_KEY");
  }

  throw new Error(
    `没有取得小红书真实正文。${errors.join("；")}。` +
    "Cloudflare 数据中心 IP 被小红书安全验证拦截时，仅靠 Browser Run 无法可靠读取；配置 TIKHUB_API_KEY 后会走结构化笔记接口。"
  );
}

async function browserMarkdown(env, url, maxChars) {
  if (!env?.BROWSER?.quickAction) throw new Error("Cloudflare Browser Run 未绑定");
  const response = await env.BROWSER.quickAction("markdown", {
    url,
    userAgent: MOBILE_UA,
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

async function readGenericLink(env, rawUrl, maxChars = 16000, browser = "auto") {
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
  const shouldUseBrowser = browser === "always" || (browser === "auto" && (!basic || looksBlocked(fetchText)));

  let browserText = "";
  let browserError = "";
  if (shouldUseBrowser) {
    try { browserText = await browserMarkdown(env, finalUrl, maxChars); }
    catch (error) { browserError = error instanceof Error ? error.message : String(error); }
  }

  const content = browserText || fetchText;
  if (!content || looksBlocked(content)) {
    throw new Error(
      [fetchError && `普通读取失败：${fetchError}`, browserError && `浏览器读取失败：${browserError}`, "没有取得可确认的正文"]
        .filter(Boolean).join("；")
    );
  }

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
  };
}

async function readLink(env, rawUrl, maxChars = 16000, browser = "auto") {
  const requested = assertSafeUrl(rawUrl).toString();
  const platform = platformFromUrl(requested);
  if (platform === "xiaohongshu") return readXiaohongshu(env, requested, maxChars);
  return readGenericLink(env, requested, maxChars, browser);
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
  if (extraHeaders) Object.entries(extraHeaders).forEach(([k, v]) => headers.set(k, String(v)));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonRpcResponse(request, id, result, extraHeaders) {
  return withCors(request, Response.json({ jsonrpc: "2.0", id: id ?? null, result }), extraHeaders);
}

function jsonRpcError(request, id, code, message, data, status = 200) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return withCors(request, Response.json({ jsonrpc: "2.0", id: id ?? null, error }, { status }));
}

const TOOL_DEFINITION = {
  name: "read_social_link",
  title: "读取社交平台链接",
  description: "读取公开社交平台链接的真实内容。小红书优先解析公开 SSR 结构化笔记数据；若 Cloudflare IP 被风控且配置了 TIKHUB_API_KEY，则使用 TikHub App V2 获取真实标题、正文、作者、图片和标签。不会把验证码/登录页当成正文。",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", format: "uri", description: "要读取的公开 http/https 链接" },
      max_chars: { type: "integer", minimum: 1000, maximum: 30000, default: 16000 },
      browser: { type: "string", enum: ["auto", "never", "always"], default: "auto", description: "非小红书网页的浏览器兜底策略" }
    },
    required: ["url"],
    additionalProperties: false
  },
  annotations: {
    title: "读取社交平台链接",
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

  if (method === "notifications/initialized") return withCors(request, new Response(null, { status: 202 }));

  if (method === "initialize") {
    const requestedVersion = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requestedVersion) ? requestedVersion : "2025-11-25";
    const sessionId = `ovo_${crypto.randomUUID()}`;
    return jsonRpcResponse(
      request,
      id,
      {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions: "提供 read_social_link。小红书仅在取得真实结构化笔记正文时才返回成功，不会把安全验证页面伪装成正文。"
      },
      { "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": protocolVersion }
    );
  }

  if (method === "ping") return jsonRpcResponse(request, id, {});
  if (method === "tools/list") return jsonRpcResponse(request, id, { tools: [TOOL_DEFINITION] });

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name !== "read_social_link") return jsonRpcError(request, id, -32602, `未知工具：${String(name || "")}`);
    if (!args.url || typeof args.url !== "string") {
      return jsonRpcResponse(request, id, { isError: true, content: [{ type: "text", text: "链接读取失败：缺少 url 参数" }] });
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

  if (method === "resources/list") return jsonRpcResponse(request, id, { resources: [] });
  if (method === "resources/templates/list") return jsonRpcResponse(request, id, { resourceTemplates: [] });
  if (method === "prompts/list") return jsonRpcResponse(request, id, { prompts: [] });
  if (method === "logging/setLevel") return jsonRpcResponse(request, id, {});

  if (id === undefined || id === null) return withCors(request, new Response(null, { status: 202 }));
  return jsonRpcError(request, id, -32601, `Method not found: ${method}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

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
          browser_binding: Boolean(env?.BROWSER),
          xhs_ssr: true,
          xhs_provider: env?.TIKHUB_API_KEY ? "tikhub+ssr" : "ssr-only",
          tikhub_configured: Boolean(env?.TIKHUB_API_KEY)
        })
      );
    }

    if (url.pathname === "/cors-test") {
      return withCors(request, Response.json({
        ok: true,
        version: VERSION,
        origin: request.headers.get("origin"),
        requested_headers: request.headers.get("access-control-request-headers") || ""
      }));
    }

    if (url.pathname !== "/mcp") return withCors(request, new Response("Not found", { status: 404 }));

    if (request.method === "POST") {
      try { return await handleMcpPost(request, env); }
      catch (error) {
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

    if (request.method === "GET") return withCors(request, new Response("Event stream not enabled", { status: 405 }));
    if (request.method === "DELETE") return withCors(request, new Response(null, { status: 204 }));
    return withCors(request, new Response("Method not allowed", { status: 405 }));
  }
};
