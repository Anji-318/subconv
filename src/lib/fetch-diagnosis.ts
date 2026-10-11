/**
 * 订阅/配置拉取失败诊断
 * 把 HTTP 状态码与网络层异常翻译成「原因 + 建议」的人类可读提示，
 * 供 /api/sub 与 /api/shorten 共用，随 error 字段透传给前端 toast。
 */

/** 安全提取目标主机名（URL 非法时退化为截断原文） */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

/** 带上下文的拉取异常：url 定位哪个链接、status 为 HTTP 状态（网络层异常时为空） */
export class SubFetchError extends Error {
  url: string;
  status?: number;
  raw?: unknown;

  constructor(url: string, status?: number, raw?: unknown) {
    super(`fetch ${url} failed${status ? `: ${status}` : ''}`);
    this.name = 'SubFetchError';
    this.url = url;
    this.status = status;
    this.raw = raw;
  }
}

/** 组合 error.message 与 cause 链（Workers 的 fetch 网络错误细节藏在 cause 里） */
function errorText(e: unknown): string {
  const err = e as { message?: string; cause?: unknown } | null;
  const main = err?.message ?? String(e ?? '');
  const cause = err?.cause instanceof Error ? err.cause.message : err?.cause ? String(err.cause) : '';
  return `${main} ${cause}`.trim();
}

const BROWSER_HINT =
  '验证方法：在浏览器直接打开该链接对照 —— 浏览器能打开而这里失败，多为目标面板防火墙拦截了 Cloudflare 服务器 IP；浏览器也打不开，则是站点自身故障，与本服务无关';

/** HTTP 状态码 → 原因 + 建议 */
export function explainFetchStatus(url: string, status: number): string {
  const host = hostOf(url);
  if (status === 401 || status === 403)
    return `目标站点拒绝访问（HTTP ${status}）。常见原因：订阅链接需要 token 或已过期；面板开启 WAF/五秒盾拦截了 Cloudflare 服务器 IP。目标：${host}。${BROWSER_HINT}`;
  if (status === 404)
    return `订阅链接不存在（HTTP 404）。常见原因：订阅已被重置或过期、复制时链接不完整。目标：${host}。${BROWSER_HINT}`;
  if (status === 429)
    return `请求过于频繁（HTTP 429）：目标面板限流，请几分钟后再试。目标：${host}`;
  if (status === 530)
    return `目标站点源站故障（HTTP 530，即 Cloudflare 1016 错误：源站 DNS 解析失败或宕机）。订阅服务器自身挂了，与你的操作无关，只能等站长修复。目标：${host}。${BROWSER_HINT}`;
  if (status >= 500)
    return `目标服务器错误（HTTP ${status}）：订阅服务端故障，请稍后再试。目标：${host}。${BROWSER_HINT}`;
  return `目标站点返回异常状态（HTTP ${status}）。目标：${host}。${BROWSER_HINT}`;
}

/** 网络层异常（DNS / 超时 / 拒绝连接等）→ 原因 + 建议 */
export function explainNetworkError(url: string, e: unknown): string {
  const host = hostOf(url);
  const msg = errorText(e);
  if (/AbortError|timeout|timed out/i.test(msg))
    return `连接超时（10 秒无响应）：${host} 不可达或网络不通。可在浏览器验证该站点是否存活`;
  if (/getaddrinfo|ENOTFOUND|Name or service not known|not known|dns/i.test(msg))
    return `域名解析失败：${host} 不存在或 DNS 记录已失效（免费动态域名过期很常见），目标站点可能已下线。${BROWSER_HINT}`;
  if (/refused|ECONNREFUSED/i.test(msg))
    return `连接被拒绝：${host} 端口未开放或服务未运行。${BROWSER_HINT}`;
  if (/certificate|SSL|TLS/i.test(msg))
    return `HTTPS 证书异常：${host} 的证书无效或已过期。${BROWSER_HINT}`;
  return `网络错误：${msg || '未知原因'}。目标：${host}。${BROWSER_HINT}`;
}

/** 统一入口：根据异常类型给出最终诊断文案（含备用方案提示） */
export function diagnoseFetchError(e: unknown): string {
  if (e instanceof SubFetchError) {
    const detail = e.status !== undefined
      ? explainFetchStatus(e.url, e.status)
      : explainNetworkError(e.url, e.raw ?? e);
    return `订阅链接获取失败 —— ${detail}。备用方案：改用「节点内容」模式，在浏览器打开订阅链接后把内容复制过来粘贴转换`;
  }
  return `订阅链接获取失败 —— ${(e as Error)?.message ?? '未知错误'}`;
}
