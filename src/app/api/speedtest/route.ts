import { NextRequest, NextResponse } from 'next/server';
import { parseSubscription, NO_NODES_HINT, type NodeInfo } from '@/lib/sub-converter';
import { SubFetchError, diagnoseFetchError } from '@/lib/fetch-diagnosis';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

interface SpeedResult {
  name: string;
  server: string;
  port: number;
  protocol: string;
  ok: boolean;
  delay: number | null;   // ms，null = 超时/失败
  err?: string;
}

/** 测单个节点 TCP 建连延迟（无 TCP 握手层面的鉴权，仅测可达性+建连耗时） */
async function testNode(n: NodeInfo, timeoutMs = 5000): Promise<SpeedResult> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // 用 fetch 测端口可达性：请求 http://server:port/，测 TCP+TLS 握手耗时（不等同真实代理延迟，但可判断可达性）
    // 注意：纯 TCP 建连用 fetch 不准，这里用 fetch 测 HTTP 层失败时间作为相对参考
    const res = await fetch(`http://${n.server}:${n.port}/`, {
      signal: ctrl.signal,
      // 不跟随重定向，不读 body，只测建连
      redirect: 'manual',
      headers: { 'User-Agent': 'SubConv-SpeedTest/1.0' },
    });
    // 无论返回什么状态码，只要能建立连接就算可达
    void res;
    const delay = Date.now() - start;
    return { name: n.name, server: n.server, port: n.port, protocol: n.protocol, ok: true, delay };
  } catch (e) {
    const err = (e as Error).message || 'failed';
    // 区分超时和其他错误
    const isTimeout = err.includes('abort') || err.includes('timeout');
    return {
      name: n.name, server: n.server, port: n.port, protocol: n.protocol,
      ok: false, delay: null,
      err: isTimeout ? `超时 (${timeoutMs}ms)` : err.slice(0, 60),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '参数错误' }, { status: 400 });
  const { raw, url, timeout = 5000, concurrency = 8 } = body as {
    raw?: string; url?: string; timeout?: number; concurrency?: number;
  };

  if (!raw && !url) return NextResponse.json({ error: '需要 url 或 raw' }, { status: 400 });

  let contents: string[] = [];
  if (raw) {
    contents = [raw];
  } else {
    const urls = url!.split('|').filter(Boolean);
    const settled = await Promise.allSettled(urls.map(async (u) => {
      const res = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'clash.meta' } });
      if (!res.ok) throw new SubFetchError(u, res.status);
      return await res.text();
    }));
    let firstErr: unknown;
    for (let i = 0; i < urls.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') contents.push(r.value);
      else if (!firstErr) firstErr = r.reason;
    }
    // 全部失败才报错；部分失败继续用成功的源
    if (contents.length === 0) {
      return NextResponse.json({ error: '订阅链接获取失败: ' + diagnoseFetchError(firstErr) }, { status: 502 });
    }
  }

  const nodes = contents.flatMap((c) => parseSubscription(c));
  if (nodes.length === 0) return NextResponse.json({ error: NO_NODES_HINT }, { status: 400 });

  // 并发测速：限制并发数
  const conc = Math.max(1, Math.min(20, concurrency));
  const results: SpeedResult[] = [];
  const queue = [...nodes];
  const workers = Array.from({ length: Math.min(conc, queue.length) }, async () => {
    while (queue.length) {
      const n = queue.shift();
      if (!n) break;
      results.push(await testNode(n, timeout));
    }
  });
  await Promise.all(workers);

  // 按延迟升序（失败排末尾）
  results.sort((a, b) => {
    if (a.delay === null && b.delay === null) return 0;
    if (a.delay === null) return 1;
    if (b.delay === null) return -1;
    return a.delay - b.delay;
  });

  const okCount = results.filter((r) => r.ok).length;
  const avgDelay = okCount ? Math.round(results.filter((r) => r.delay).reduce((s, r) => s + (r.delay || 0), 0) / okCount) : null;

  return NextResponse.json({
    success: true,
    total: nodes.length,
    ok: okCount,
    fail: nodes.length - okCount,
    avgDelay,
    results,
  });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('target') || '';
  void target;
  return NextResponse.json({
    name: 'SubConv SpeedTest',
    usage: 'POST /api/speedtest body: {raw?, url?, timeout=5000, concurrency=8}',
    note: '测速基于 TCP 建连可达性，非真实代理延迟。仅作节点可达性参考。',
  });
}
