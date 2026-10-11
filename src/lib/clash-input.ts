/**
 * Clash YAML 配置输入支持
 * 场景：机场/聚合面板返回的是一整份 Clash/mihomo YAML 配置（含顶层 proxies: 段），
 * 而不是节点分享链接或 Base64。此处把 YAML 里的 proxies 反向映射回 NodeInfo，
 * 让转换器也能"吃"这种格式。
 * 支持类型：vless / vmess / trojan / ss（带 plugin 的 ss 无法无损往返，跳过）。
 * 不支持类型（http/socks5/hysteria2/tuic 等）自动跳过，不影响其余节点。
 */
import { parse } from 'yaml';
import type { NodeInfo } from './sub-converter';

/** 是否看起来是 Clash YAML（顶层 proxies: 段，行首无缩进才匹配，proxy-groups 里的嵌套 proxies 不算） */
export function looksLikeClashYaml(content: string): boolean {
  return /^proxies:\s*(?:#.*)?$/m.test(content);
}

function asStr(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function asAlpn(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    const list = v.map((x) => String(x).trim()).filter(Boolean);
    return list.length ? list.join(',') : undefined;
  }
  return asStr(v);
}

/** 从单个 Clash proxy 条目映射回 NodeInfo；无法映射返回 null */
function entryToNode(e: Record<string, unknown>): NodeInfo | null {
  const type = asStr(e.type)?.toLowerCase();
  const server = asStr(e.server);
  const port = typeof e.port === 'number' ? e.port : parseInt(String(e.port)) || 0;
  const name = asStr(e.name) || `${server}:${port}`;
  if (!server || !port || !type) return null;

  // 网络层通用字段（ws-opts / xhttp-opts / grpc-opts / h2-opts）
  const wsOpts = (e['ws-opts'] ?? {}) as Record<string, unknown>;
  const wsHeaders = (wsOpts.headers ?? {}) as Record<string, unknown>;
  const xhttpOpts = (e['xhttp-opts'] ?? {}) as Record<string, unknown>;
  const h2Opts = (e['h2-opts'] ?? {}) as Record<string, unknown>;
  const grpcOpts = (e['grpc-opts'] ?? {}) as Record<string, unknown>;
  const network = (asStr(e.network) || 'tcp').toLowerCase();
  const params: Record<string, string> = {};

  let host: string | undefined;
  let path: string | undefined;
  if (network === 'ws') {
    host = asStr(wsHeaders.Host) ?? asStr(wsHeaders.host);
    path = asStr(wsOpts.path) || '/';
    const ed = wsOpts['max-early-data'];
    if (ed !== undefined && ed !== null && String(ed) !== '0') params['ed'] = String(ed);
  } else if (network === 'xhttp') {
    host = asStr(xhttpOpts.host);
    path = asStr(xhttpOpts.path) || '/';
    const mode = asStr(xhttpOpts.mode);
    if (mode) params['xmode'] = mode;
  } else if (network === 'h2') {
    const h2Host = h2Opts.host;
    host = Array.isArray(h2Host) ? asStr(h2Host[0]) : asStr(h2Host);
    path = asStr(h2Opts.path) || '/';
  } else if (network === 'grpc') {
    const sn = asStr(grpcOpts['grpc-service-name']);
    if (sn) params['serviceName'] = sn;
  }

  const sni = asStr(e.servername) ?? asStr(e.sni) ?? undefined;
  const alpn = asAlpn(e.alpn);
  const fp = asStr(e['client-fingerprint']);
  const tls = e.tls === true || e.tls === 'true';

  if (type === 'vless' || type === 'vmess') {
    const uuid = asStr(e.uuid);
    if (!uuid) return null;
    const reality = (e['reality-opts'] ?? {}) as Record<string, unknown>;
    return {
      protocol: type,
      server, port, uuid, name,
      network: network as NodeInfo['network'],
      sni: sni ?? server,
      host, path, alpn, fp,
      pbk: asStr(reality['public-key']),
      sid: asStr(reality['short-id']),
      flow: asStr(e.flow),
      alterId: type === 'vmess' ? (typeof e.alterId === 'number' ? e.alterId : parseInt(String(e.alterId ?? '0')) || 0) : undefined,
      tls,
      params,
    };
  }

  if (type === 'trojan') {
    const password = asStr(e.password);
    if (!password) return null;
    return {
      protocol: 'trojan',
      server, port, password, name,
      network: network as NodeInfo['network'],
      sni: sni ?? server,
      host, path, alpn, fp,
      tls: true, // trojan 恒为 TLS
      params,
    };
  }

  if (type === 'ss') {
    // obfs/v2ray-plugin 无法无损往返，跳过避免生成坏节点
    if (e.plugin) return null;
    const method = asStr(e.cipher);
    const password = asStr(e.password);
    if (!method || !password) return null;
    return { protocol: 'ss', server, port, method, password, name, network: 'tcp', params: {} };
  }

  return null; // http/socks5/hysteria2/tuic 等暂不支持
}

/** 从混排文本中提取顶层 proxies: 段（直到下一个顶层键） */
function extractProxiesSection(text: string): string | null {
  const m = text.match(/^proxies:[ \t]*(?:#.*)?$/m);
  if (!m || m.index === undefined) return null;
  const rest = text.slice(m.index + m[0].length);
  const lines = rest.split(/\r?\n/);
  const section: string[] = [];
  for (const line of lines) {
    // 顶层键（行首无缩进的 key:）= proxies 段结束；注释行与空行保留
    if (/^[A-Za-z0-9_-]+[ \t]*:/.test(line)) break;
    section.push(line);
  }
  const body = section.join('\n'); // 保持原始缩进（trim 会剥掉首行缩进导致 YAML 列对齐报错）
  return /\S/.test(body) ? `proxies:\n${body}` : null;
}

/**
 * 解析整份 Clash YAML 配置，提取 proxies 为 NodeInfo[]。
 * 支持整份配置，也支持混排文本（前后夹着链接/JSON 等）——整份解析失败时自动提取 proxies: 段单独解析。
 * 解析失败或没有可识别节点时返回空数组（调用方回退到原有解析路径）。
 */
export function parseClashYamlProxies(content: string): NodeInfo[] {
  const attempt = (yamlText: string): NodeInfo[] | null => {
    try {
      const doc = parse(yamlText) as Record<string, unknown> | null;
      const proxies = doc?.proxies;
      if (!Array.isArray(proxies)) return null;
      const nodes: NodeInfo[] = [];
      for (const item of proxies) {
        if (!item || typeof item !== 'object') continue;
        const n = entryToNode(item as Record<string, unknown>);
        if (n) nodes.push(n);
      }
      return nodes;
    } catch {
      return null;
    }
  };
  // 先按整份 YAML 解析
  const whole = attempt(content);
  if (whole && whole.length) return whole;
  // 混排兜底：提取 proxies: 段单独解析
  const section = extractProxiesSection(content);
  if (section) {
    const frag = attempt(section);
    if (frag && frag.length) return frag;
  }
  return [];
}
