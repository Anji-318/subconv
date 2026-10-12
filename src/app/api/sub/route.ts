import { NextRequest, NextResponse } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';
import { parseSubscription, toClash, toSingbox, toV2ray, toSurge, toQuantumultX, toLoon, toMixed, toLink, parseConfigIni, DEFAULT_CONFIG, dedupNodes, renameNodes, getUnsupported, NO_NODES_HINT, type NodeInfo, type SubConfig } from '@/lib/sub-converter';
import { SubFetchError, diagnoseFetchError } from '@/lib/fetch-diagnosis';

export const runtime = 'edge';

const TARGETS = ['clash', 'clashmeta', 'singbox', 'surge', 'quantumultx', 'loon', 'v2ray', 'mixed'] as const;
type Target = typeof TARGETS[number];

const TARGET_META: Record<Target, { ct: string; ext: string; fn: (nodes: NodeInfo[], name: string, cfg?: SubConfig) => string }> = {
  clash: { ct: 'text/yaml; charset=utf-8', ext: 'yaml', fn: (n, s, c) => toClash(n, s, c) },
  clashmeta: { ct: 'text/yaml; charset=utf-8', ext: 'yaml', fn: (n, s, c) => toClash(n, s, c) },
  singbox: { ct: 'application/json; charset=utf-8', ext: 'json', fn: (n, s) => toSingbox(n, s) },
  surge: { ct: 'text/plain; charset=utf-8', ext: 'conf', fn: (n, s) => toSurge(n, s) },
  quantumultx: { ct: 'text/plain; charset=utf-8', ext: 'conf', fn: (n) => toQuantumultX(n) },
  loon: { ct: 'text/plain; charset=utf-8', ext: 'conf', fn: (n, s) => toLoon(n, s) },
  v2ray: { ct: 'text/plain; charset=utf-8', ext: 'txt', fn: (n) => toV2ray(n) },
  mixed: { ct: 'text/plain; charset=utf-8', ext: 'txt', fn: (n) => toMixed(n) },
};

/** 一次转换请求的完整参数（短链接记录与 URL/POST 参数共用此结构） */
interface SubParams {
  target: Target;
  name: string;
  url?: string;
  raw?: string;
  configUrl?: string;
  configRaw?: string;
  dedup?: boolean;
  renamePrefix?: string;
  renameMode?: 'prefix-seq' | 'keep-seq' | 'prefix-only';
}

/** 读取 KV 绑定；未配置（或本地非 CF 环境）返回 null */
function getKV(): KVNamespace | null {
  try {
    const { env } = getRequestContext();
    return (env as unknown as CloudflareEnv).SUBS_KV ?? null;
  } catch {
    return null;
  }
}

/** 解析配置规则：configUrl（远程） > configRaw（自定义内容） > 默认 */
async function resolveConfig(configUrl?: string, configRaw?: string): Promise<SubConfig> {
  if (configUrl) {
    try {
      const res = await fetch(configUrl, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'clash.meta' } });
      if (res.ok) return parseConfigIni(await res.text());
    } catch { }
  }
  if (configRaw) return parseConfigIni(configRaw);
  return DEFAULT_CONFIG;
}

/** 获取订阅内容：raw 直传 或 url 拉取（多链接 | 分隔，部分失败不阻断其余源） */
async function fetchContents(url?: string, raw?: string): Promise<{ ok: true; contents: string[]; failed: string[] } | { ok: false; error: string; status: number }> {
  if (raw) return { ok: true, contents: [raw], failed: [] };
  if (!url) return { ok: false, status: 400, error: '需要 url 参数（订阅链接，多个用 | 分隔）、raw 参数（链接内容）或 id 参数（短链接）' };
  const urls = url.split('|').filter(Boolean);
  const settled = await Promise.allSettled(urls.map(async (u) => {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'clash.meta/v2rayN' } });
      if (!res.ok) throw new SubFetchError(u, res.status);
      return await res.text();
    } catch (e) {
      if (e instanceof SubFetchError) throw e;
      throw new SubFetchError(u, undefined, e); // 网络层异常：保留 url 供诊断
    }
  }));
  const contents: string[] = [];
  const failed: string[] = [];
  let firstErr: unknown;
  for (let i = 0; i < urls.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') contents.push(r.value);
    else {
      if (!firstErr) firstErr = r.reason;
      failed.push(diagnoseFetchError(r.reason));
    }
  }
  // 全部失败才报错；部分失败继续用成功的源（合并场景下单个机场挂了不该拖垮全部）
  if (contents.length === 0) {
    return { ok: false, status: 502, error: diagnoseFetchError(firstErr) };
  }
  return { ok: true, contents, failed };
}

/** 节点去重 + 重命名（GET 短链还原与 POST 预览共用，保证行为一致） */
function processNodes(nodes: NodeInfo[], p: Pick<SubParams, 'dedup' | 'renamePrefix' | 'renameMode'>): { nodes: NodeInfo[]; dedupRemoved: number } {
  let out = nodes;
  let dedupRemoved = 0;
  if (p.dedup) {
    const r = dedupNodes(out);
    out = r.nodes;
    dedupRemoved = r.removed;
  }
  if (p.renamePrefix || p.renameMode === 'keep-seq') {
    out = renameNodes(out, { prefix: p.renamePrefix || '', mode: p.renameMode || 'prefix-seq' });
  }
  return { nodes: out, dedupRemoved };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // ---- 组装参数：id 短链模式从 KV 还原，否则取 URL 参数 ----
  let params: SubParams;
  const id = searchParams.get('id');
  if (id) {
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
      return NextResponse.json({ error: '短链接 ID 格式无效' }, { status: 400 });
    }
    const kv = getKV();
    if (!kv) {
      return NextResponse.json({ error: '短链接功能未启用：服务端未绑定 KV 命名空间 SUBS_KV（见 DEPLOY.md）' }, { status: 501 });
    }
    const record = await kv.get(`sub:${id}`, { type: 'json' }).catch(() => null) as (SubParams & { v?: number }) | null;
    if (!record || record.v !== 1 || !record.target || !TARGETS.includes(record.target)) {
      return NextResponse.json({ error: '短链接不存在或已过期' }, { status: 404 });
    }
    params = { ...record, target: record.target, name: record.name || '订阅转换' };
  } else {
    const target = (searchParams.get('target') || 'clash') as Target;
    params = {
      target,
      name: searchParams.get('name') || '订阅转换',
      url: searchParams.get('url') || undefined,
      raw: searchParams.get('raw') || undefined,
      configUrl: searchParams.get('config') || undefined,
      configRaw: searchParams.get('configRaw') || undefined,
      dedup: searchParams.get('dedup') === '1',
      renamePrefix: searchParams.get('renamePrefix') || undefined,
      renameMode: (searchParams.get('renameMode') as SubParams['renameMode']) || undefined,
    };
  }

  if (!TARGETS.includes(params.target)) {
    return NextResponse.json({ error: 'target 参数无效，支持: clash / singbox / v2ray' }, { status: 400 });
  }

  // ---- 获取订阅内容（每个订阅源独立解析：不同格式可混用合并）----
  const contentRes = await fetchContents(params.url, params.raw);
  if (!contentRes.ok) {
    return NextResponse.json({ error: contentRes.error }, { status: contentRes.status });
  }

  const nodes = contentRes.contents.flatMap((c) => parseSubscription(c));
  if (nodes.length === 0) {
    return NextResponse.json({ error: NO_NODES_HINT }, { status: 400 });
  }

  // ---- 节点处理（去重/重命名）+ 配置 + 输出 ----
  const { nodes: processed } = processNodes(nodes, params);
  const config = await resolveConfig(params.configUrl, params.configRaw);
  const meta = TARGET_META[params.target];
  const body = meta.fn(processed, params.name, config);

  // 文件名用 RFC 5987 编码支持中文：旧客户端用回退名 subscription.ext，新客户端用自定义名称
  const fileBase = encodeURIComponent(params.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return new NextResponse(body, {
    headers: {
      'Content-Type': meta.ct,
      'Content-Disposition': `attachment; filename="subscription.${meta.ext}"; filename*=UTF-8''${fileBase}.${meta.ext}`,
      'Cache-Control': 'no-store',
      'Subscription-Userinfo': `nodes=${processed.length}`,
      ...(contentRes.failed.length ? { 'X-Subconv-Warning': `${contentRes.failed.length} 个订阅源获取失败已跳过` } : {}),
    },
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '参数错误' }, { status: 400 });
  const { url, raw, target, name, configUrl, configRaw, dedup, renamePrefix, renameMode } = body as {
    url?: string; raw?: string; target: Target; name?: string;
    configUrl?: string; configRaw?: string;
    dedup?: boolean; renamePrefix?: string; renameMode?: 'prefix-seq' | 'keep-seq' | 'prefix-only';
  };

  if (!url && !raw) return NextResponse.json({ error: '需要 url 或 raw' }, { status: 400 });
  if (!TARGETS.includes(target)) return NextResponse.json({ error: 'target 无效' }, { status: 400 });

  // 智能识别：非 http/https 协议提示用节点内容 tab
  if (!raw && url) {
    const urls = url.split('|').filter(Boolean);
    const nonHttp = urls.find(u => !/^https?:\/\//i.test(u));
    if (nonHttp) return NextResponse.json({ error: `检测到非订阅链接（${nonHttp.slice(0, 40)}...），请切换到「节点内容」标签粘贴节点链接` }, { status: 400 });
  }

  const contentRes = await fetchContents(url, raw);
  if (!contentRes.ok) {
    return NextResponse.json({ error: contentRes.error }, { status: contentRes.status });
  }

  const nodes = contentRes.contents.flatMap((c) => parseSubscription(c));
  if (nodes.length === 0) return NextResponse.json({ error: NO_NODES_HINT }, { status: 400 });

  const { nodes: processed, dedupRemoved } = processNodes(nodes, { dedup, renamePrefix, renameMode });

  // 不支持协议检测
  const unsupported = getUnsupported(target, processed);

  const config = await resolveConfig(configUrl, configRaw);
  const meta = TARGET_META[target];
  const result = meta.fn(processed, name || '订阅转换', config);

  return NextResponse.json({
    success: true, target, count: processed.length,
    nodes: processed.map(n => ({ name: n.name, protocol: n.protocol, server: n.server, port: n.port, link: toLink(n) })),
    configInfo: { groups: config.groups.length, rulesets: config.rulesets.length, customRules: config.customRules.length },
    dedupRemoved,
    unsupported,
    ...(contentRes.failed.length ? { fetchWarnings: contentRes.failed } : {}),
    result
  });
}
