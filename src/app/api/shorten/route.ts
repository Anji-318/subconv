import { NextRequest, NextResponse } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';
import { parseSubscription } from '@/lib/sub-converter';

export const runtime = 'edge';

const TARGETS = ['clash', 'clashmeta', 'singbox', 'surge', 'quantumultx', 'loon', 'v2ray', 'mixed'] as const;
type Target = typeof TARGETS[number];

/** 短链 ID 字符表：base62 去掉易混淆字符（0/O/1/l/I） */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** 生成加密安全的短链 ID（8 位 ≈ 46 bit 熵，不可枚举） */
function genId(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** KV 中存储的短链记录：完整还原一次 /api/sub 请求所需的全部参数 */
interface ShortenRecord {
  v: 1;
  target: Target;
  name: string;
  url?: string;
  raw?: string;
  configUrl?: string;
  configRaw?: string;
  dedup?: boolean;
  renamePrefix?: string;
  renameMode?: 'prefix-seq' | 'keep-seq' | 'prefix-only';
  createdAt: number;
}

/** 读取 KV 绑定；未配置（或非 Cloudflare 环境）返回 null */
function getKV(): KVNamespace | null {
  try {
    const { env } = getRequestContext();
    return (env as unknown as CloudflareEnv).SUBS_KV ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '参数错误' }, { status: 400 });
  const { url, raw, target, name, configUrl, configRaw, dedup, renamePrefix, renameMode, ttlDays } = body as {
    url?: string; raw?: string; target?: Target; name?: string;
    configUrl?: string; configRaw?: string;
    dedup?: boolean; renamePrefix?: string; renameMode?: 'prefix-seq' | 'keep-seq' | 'prefix-only';
    ttlDays?: number;
  };

  if (!url && !raw) return NextResponse.json({ error: '需要 url 或 raw' }, { status: 400 });
  if (!target || !TARGETS.includes(target)) return NextResponse.json({ error: 'target 无效' }, { status: 400 });
  if (raw && raw.length > 1024 * 1024) return NextResponse.json({ error: '节点内容过大（上限 1MB）' }, { status: 413 });

  // 先校验订阅可解析，避免把无效内容写进 KV
  let content = raw;
  if (!content) {
    const urls = url!.split('|').filter(Boolean);
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
  const nodes = parseSubscription(content);
  if (nodes.length === 0) return NextResponse.json({ error: '未解析到有效节点' }, { status: 400 });

  const kv = getKV();
  if (!kv) {
    return NextResponse.json({
      error: '短链接功能未启用：需要先绑定 KV 命名空间（绑定名 SUBS_KV）。'
        + 'Cloudflare Dashboard → Pages → 本项目 → 设置 → 函数 → KV 命名空间绑定 → 添加 SUBS_KV，详见项目 DEPLOY.md',
    }, { status: 501 });
  }

  // TTL：1~365 天，默认 90 天（KV 条目到期自动删除）
  const ttl = Math.min(365, Math.max(1, Math.round(Number(ttlDays) || 90)));
  const record: ShortenRecord = {
    v: 1,
    target,
    name: (name || '订阅转换').slice(0, 100),
    url: url || undefined,
    raw: raw || undefined,
    configUrl: configUrl || undefined,
    configRaw: configRaw || undefined,
    dedup: !!dedup,
    renamePrefix: renamePrefix || undefined,
    renameMode: renameMode || undefined,
    createdAt: Date.now(),
  };

  // 撞键重试（8 位 ID 空间 ~2^46，实际几乎不可能撞）
  for (let i = 0; i < 3; i++) {
    const id = genId(8);
    const key = `sub:${id}`;
    const existing = await kv.get(key).catch(() => null);
    if (existing) continue;
    await kv.put(key, JSON.stringify(record), { expirationTtl: ttl * 86400 });
    const origin = new URL(request.url).origin;
    return NextResponse.json({
      success: true,
      id,
      shortUrl: `${origin}/api/sub?id=${id}`,
      ttlDays: ttl,
      nodes: nodes.length,
    });
  }
  return NextResponse.json({ error: '短链 ID 分配失败，请重试' }, { status: 500 });
}

export async function GET() {
  return NextResponse.json({
    name: 'SubConv ShortLink',
    usage: 'POST /api/shorten body: { url?|raw?, target, name?, configUrl?, configRaw?, dedup?, renamePrefix?, renameMode?, ttlDays? }',
    note: '需要绑定 KV 命名空间 SUBS_KV。短链接格式: /api/sub?id=xxxxxxxx',
  });
}
