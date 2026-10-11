import { NextRequest, NextResponse } from 'next/server';
import { parseSubscription, toClash, toSingbox, toV2ray, toSurge, toQuantumultX, toLoon, toMixed, toLink, parseConfigIni, DEFAULT_CONFIG, dedupNodes, renameNodes, getUnsupported, type NodeInfo, type SubConfig } from '@/lib/sub-converter';

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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const target = (searchParams.get('target') || 'clash') as Target;
  const urlParam = searchParams.get('url') || '';
  const subName = searchParams.get('name') || '订阅转换';
  const raw = searchParams.get('raw');
  const configUrl = searchParams.get('config') || undefined;
  const configRaw = searchParams.get('configRaw') || undefined;

  if (!TARGETS.includes(target)) {
    return NextResponse.json({ error: 'target 参数无效，支持: clash / singbox / v2ray' }, { status: 400 });
  }

  let content = '';
  if (raw) {
    content = raw;
  } else if (urlParam) {
    const urls = urlParam.split('|').filter(Boolean);
    try {
      const results = await Promise.all(urls.map(async (u) => {
        const res = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'clash.meta/v2rayN' } });
        if (!res.ok) throw new Error(`fetch ${u} failed: ${res.status}`);
        return await res.text();
      }));
      content = results.join('\n');
    } catch (e) {
      return NextResponse.json({ error: '订阅链接获取失败: ' + (e as Error).message }, { status: 502 });
    }
  } else {
    return NextResponse.json({ error: '需要 url 参数（订阅链接，多个用 | 分隔）或 raw 参数（链接内容）' }, { status: 400 });
  }

  const nodes = parseSubscription(content);
  if (nodes.length === 0) {
    return NextResponse.json({ error: '未解析到有效节点，请检查订阅内容' }, { status: 400 });
  }

  const config = await resolveConfig(configUrl, configRaw);
  const meta = TARGET_META[target];
  const body = meta.fn(nodes, subName, config);

  return new NextResponse(body, {
    headers: {
      'Content-Type': meta.ct,
      'Content-Disposition': `attachment; filename="subscription.${meta.ext}"`,
      'Cache-Control': 'no-store',
      'Subscription-Userinfo': `nodes=${nodes.length}`,
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

  let content = '';
  if (raw) {
    content = raw;
  } else {
    // 智能识别：非 http/https 协议提示用节点内容 tab
    const urls = url!.split('|').filter(Boolean);
    const nonHttp = urls.find(u => !/^https?:\/\//i.test(u));
    if (nonHttp) return NextResponse.json({ error: `检测到非订阅链接（${nonHttp.slice(0, 40)}...），请切换到「节点内容」标签粘贴节点链接` }, { status: 400 });
    try {
      const results = await Promise.all(urls.map(async (u) => {
        const res = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'clash.meta/v2rayN' } });
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        return await res.text();
      }));
      content = results.join('\n');
    } catch (e) {
      return NextResponse.json({ error: '订阅链接获取失败: ' + (e as Error).message }, { status: 502 });
    }
  }

  let nodes = parseSubscription(content);
  if (nodes.length === 0) return NextResponse.json({ error: '未解析到有效节点' }, { status: 400 });

  // 去重
  let dedupRemoved = 0;
  if (dedup) {
    const r = dedupNodes(nodes);
    nodes = r.nodes;
    dedupRemoved = r.removed;
  }

  // 重命名
  if (renamePrefix || renameMode === 'keep-seq') {
    nodes = renameNodes(nodes, { prefix: renamePrefix || '', mode: renameMode || 'prefix-seq' });
  }

  // 不支持协议检测
  const unsupported = getUnsupported(target, nodes);

  const config = await resolveConfig(configUrl, configRaw);
  const meta = TARGET_META[target];
  const result = meta.fn(nodes, name || '订阅转换', config);

  return NextResponse.json({
    success: true, target, count: nodes.length,
    nodes: nodes.map(n => ({ name: n.name, protocol: n.protocol, server: n.server, port: n.port, link: toLink(n) })),
    configInfo: { groups: config.groups.length, rulesets: config.rulesets.length, customRules: config.customRules.length },
    dedupRemoved,
    unsupported,
    result
  });
}
