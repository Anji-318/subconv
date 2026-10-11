/**
 * JSON 订阅输入支持
 * - sing-box 完整配置（{ outbounds: [...] }）
 * - v2ray JSON 订阅（[ { add/port/id/ps... }, ... ]，v2rayN 分享 JSON 数组格式）
 * 仅提取 vless/vmess/trojan/ss；其余协议（hysteria2/tuic/wireguard 等）自动跳过，不影响其余节点。
 */
import type { NodeInfo } from './sub-converter';

function s(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = String(v).trim();
  return t === '' ? undefined : t;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** 首个元素：数组取第一个非空，字符串直接返回 */
function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const x of v) { const r = s(x); if (r) return r; }
    return undefined;
  }
  return s(v);
}

/** sing-box transport → NodeInfo 传输层字段；不支持的传输返回 tcp（仅保留基础连通参数） */
function sbTransport(t: Record<string, unknown> | undefined): Pick<NodeInfo, 'network' | 'host' | 'path'> & { serviceName?: string } {
  const type = s(t?.type)?.toLowerCase();
  const path = s(t?.path);
  if (type === 'ws') {
    const headers = (t?.headers ?? {}) as Record<string, unknown>;
    return { network: 'ws', host: firstStr(headers.Host ?? headers.host), path: path || '/' };
  }
  if (type === 'grpc') {
    return { network: 'grpc', serviceName: s(t?.['service_name']) };
  }
  if (type === 'http' || type === 'h2') {
    return { network: 'h2', host: firstStr(t?.host), path: path || '/' };
  }
  return { network: 'tcp' };
}

/**
 * 提取文本中所有"行首 JSON 块"（{ 或 [ 位于行首、之前仅允许缩进），
 * 字符串感知配平扫描。只认行首可避免把 YAML 里的 alpn: ["h2",...] 之类内联数组误当 JSON。
 */
export function extractJsonBlocks(text: string, max = 10): string[] {
  const blocks: string[] = [];
  const re = /^[ \t]*([[{])/gm;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && blocks.length < max) {
    if (m.index < lastEnd) continue; // 落在上一个块内部
    const start = m.index + m[0].indexOf(m[1]);
    const open = m[1];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break; // 未配平，放弃剩余部分
    const block = text.slice(start, end + 1);
    if (block.length > 8) { // 过滤行首小数组（不可能是订阅 JSON）
      blocks.push(block);
      lastEnd = end + 1;
    }
  }
  return blocks;
}

/** sing-box 完整配置 → NodeInfo[] */
export function parseSingboxJson(content: string): NodeInfo[] {
  try {
    const doc = JSON.parse(content) as Record<string, unknown> | null;
    const outbounds = doc?.outbounds;
    if (!Array.isArray(outbounds)) return [];
    const nodes: NodeInfo[] = [];
    for (const item of outbounds) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const type = s(o.type)?.toLowerCase();
      const server = s(o.server);
      const port = num(o.server_port ?? o.port);
      const name = s(o.tag) || `${server}:${port}`;
      if (!server || !port) continue;

      const tlsObj = (o.tls ?? {}) as Record<string, unknown>;
      const tlsEnabled = tlsObj.enabled === true;
      const reality = (tlsObj.reality ?? {}) as Record<string, unknown>;
      const utls = (tlsObj.utls ?? {}) as Record<string, unknown>;
      const alpn = Array.isArray(tlsObj.alpn) ? (tlsObj.alpn as unknown[]).map(String).join(',') : s(tlsObj.alpn);
      const tr = sbTransport((o.transport ?? {}) as Record<string, unknown>);
      const params: Record<string, string> = {};
      if (tr.serviceName) params['serviceName'] = tr.serviceName;

      if (type === 'vless' || type === 'vmess') {
        const uuid = s(o.uuid);
        if (!uuid) continue;
        nodes.push({
          protocol: type,
          server, port, uuid, name,
          network: tr.network,
          sni: s(tlsObj.server_name) ?? server,
          host: tr.host,
          path: tr.path,
          alpn,
          fp: s(utls.fingerprint),
          pbk: reality.enabled === true ? s(reality.public_key) : undefined,
          sid: s(reality.short_id),
          flow: s(o.flow),
          alterId: type === 'vmess' ? num(o.alter_id ?? o.alterId) : undefined,
          tls: tlsEnabled,
          params,
        });
        continue;
      }
      if (type === 'trojan') {
        const password = s(o.password);
        if (!password) continue;
        nodes.push({
          protocol: 'trojan',
          server, port, password, name,
          network: tr.network,
          sni: s(tlsObj.server_name) ?? server,
          host: tr.host,
          path: tr.path,
          alpn,
          fp: s(utls.fingerprint),
          tls: true, // trojan 恒为 TLS
          params,
        });
        continue;
      }
      if (type === 'ss') {
        const method = s(o.method);
        const password = s(o.password);
        if (!method || !password) continue;
        nodes.push({ protocol: 'ss', server, port, method, password, name, network: 'tcp', params: {} });
        continue;
      }
      // hysteria2/tuic/wireguard/socks/http 等暂不支持，跳过
    }
    return nodes;
  } catch {
    return [];
  }
}

/** v2ray JSON 订阅（v2rayN 导出的 JSON 数组）→ NodeInfo[] */
export function parseV2rayJsonArray(content: string): NodeInfo[] {
  try {
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) return [];
    const nodes: NodeInfo[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const j = item as Record<string, unknown>;
      const server = s(j.add) ?? s(j.address);
      const port = num(j.port);
      const uuid = s(j.id);
      if (!server || !port || !uuid) continue;
      const name = s(j.ps) ?? s(j.remarks) ?? (s(j.name) || `${server}:${port}`);
      nodes.push({
        protocol: 'vmess',
        server, port, uuid, name,
        network: (s(j.net) || 'tcp') as NodeInfo['network'],
        sni: s(j.sni) ?? s(j.host) ?? server,
        host: s(j.host),
        path: s(j.path),
        alpn: s(j.alpn),
        fp: s(j.fp),
        alterId: num(j.aid ?? j.alterId),
        tls: String(j.tls ?? '') === 'tls',
        params: {},
      });
    }
    return nodes;
  } catch {
    return [];
  }
}
