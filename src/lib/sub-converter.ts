/**
 * 订阅转换核心库
 * 支持：vless/vmess/trojan/ss 链接解析 → clash/singbox/v2ray 输出
 */

export type Protocol = 'vless' | 'vmess' | 'trojan' | 'ss';

export interface NodeInfo {
  protocol: Protocol;
  server: string;
  port: number;
  uuid?: string;       // vless/vmess
  password?: string;   // trojan/ss
  method?: string;     // ss
  name: string;
  network?: 'ws' | 'tcp' | 'grpc' | 'h2' | 'xhttp';
  sni?: string;
  host?: string;
  path?: string;
  alpn?: string;
  fp?: string;         // 指纹
  pbk?: string;        // reality public key
  sid?: string;        // reality short id
  flow?: string;
  alterId?: number;    // vmess
  tls?: boolean;
  params?: Record<string, string>;
}

/** base64 url safe 解码 */
function b64uDecode(s: string): string {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  try { return Buffer.from(t, 'base64').toString('utf8'); } catch { return ''; }
}

/** base64 解码（兼容 url safe） */
function b64Decode(s: string): string {
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; }
}

/** url 编码字符串转对象 */
function queryToObj(q: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const pair of q.split('&')) {
    const [k, v] = pair.split('=');
    if (k) o[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
  }
  return o;
}

/** 解析单行链接 */
export function parseLine(line: string): NodeInfo | null {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;
  try {
    if (line.startsWith('vless://')) return parseVless(line);
    if (line.startsWith('vmess://')) return parseVmess(line);
    if (line.startsWith('trojan://')) return parseTrojan(line);
    if (line.startsWith('ss://')) return parseSS(line);
  } catch { }
  return null;
}

function parseVless(url: string): NodeInfo | null {
  const u = new URL(url);
  const uuid = decodeURIComponent(u.username);
  const host = u.hostname;
  const port = parseInt(u.port) || 443;
  const p = queryToObj(u.search.slice(1));
  const name = decodeURIComponent(u.hash.slice(1)) || `${host}:${port}`;
  const network = (p.type || 'tcp') as NodeInfo['network'];
  const security = p.security || '';
  return {
    protocol: 'vless',
    server: host, port, uuid, name,
    network,
    sni: p.sni || p.peer || host,
    host: p.host,
    path: p.path ? decodeURIComponent(p.path) : undefined,
    alpn: p.alpn,
    fp: p.fp,
    pbk: p.pbk,
    sid: p.sid,
    flow: p.flow,
    tls: security === 'tls' || security === 'reality',
    params: p,
  };
}

function parseVmess(url: string): NodeInfo | null {
  const json = JSON.parse(b64uDecode(url.slice('vmess://'.length)));
  const host = json.add || json.address;
  const port = parseInt(json.port) || 443;
  return {
    protocol: 'vmess',
    server: host, port,
    uuid: json.id,
    alterId: parseInt(json.aid) || 0,
    name: json.ps || `${host}:${port}`,
    network: (json.net || 'tcp') as NodeInfo['network'],
    sni: json.sni || json.host || host,
    host: json.host,
    path: json.path,
    alpn: json.alpn,
    tls: json.tls === 'tls',
    params: {},
  };
}

function parseTrojan(url: string): NodeInfo | null {
  const u = new URL(url);
  const password = decodeURIComponent(u.username);
  const host = u.hostname;
  const port = parseInt(u.port) || 443;
  const p = queryToObj(u.search.slice(1));
  const name = decodeURIComponent(u.hash.slice(1)) || `${host}:${port}`;
  return {
    protocol: 'trojan',
    server: host, port, password, name,
    network: (p.type || 'tcp') as NodeInfo['network'],
    sni: p.sni || p.peer || host,
    host: p.host,
    path: p.path ? decodeURIComponent(p.path) : undefined,
    alpn: p.alpn,
    fp: p.fp,
    tls: true,
    params: p,
  };
}

function parseSS(url: string): NodeInfo | null {
  // ss://base64(method:password)@host:port#name  或  ss://base64(method:password@host:port)#name
  let body = url.slice('ss://'.length);
  let name = '';
  const hashIdx = body.indexOf('#');
  if (hashIdx !== -1) {
    name = decodeURIComponent(body.slice(hashIdx + 1));
    body = body.slice(0, hashIdx);
  }
  let method = '', password = '', host = '', port = 0;
  let portStr = '';
  if (body.includes('@')) {
    // base64(method:password)@host:port
    const atIdx = body.lastIndexOf('@');
    const cred = b64uDecode(body.slice(0, atIdx));
    const hostPort = body.slice(atIdx + 1);
    [method, password] = cred.split(':');
    [host, portStr] = hostPort.split(':');
    port = parseInt(portStr) || 443;
  } else {
    // 整段 base64
    const decoded = b64uDecode(body);
    const atIdx = decoded.lastIndexOf('@');
    const cred = decoded.slice(0, atIdx);
    const hostPort = decoded.slice(atIdx + 1);
    [method, password] = cred.split(':');
    [host, portStr] = hostPort.split(':');
    port = parseInt(portStr) || 443;
  }
  if (!host || !port) return null;
  return {
    protocol: 'ss',
    server: host, port, method, password,
    name: name || `${host}:${port}`,
    network: 'tcp',
    params: {},
  };
}

/** 解析订阅内容（base64 整段 或 多行链接） */
export function parseSubscription(content: string): NodeInfo[] {
  const trimmed = content.trim();
  // 尝试 base64 整段解码
  let lines: string[];
  if (!trimmed.includes('://') && !trimmed.startsWith('#')) {
    const decoded = b64Decode(trimmed.replace(/\s/g, ''));
    lines = decoded.split(/\r?\n/);
  } else {
    lines = trimmed.split(/\r?\n/);
  }
  const nodes: NodeInfo[] = [];
  for (const line of lines) {
    const n = parseLine(line);
    if (n) nodes.push(n);
  }
  return nodes;
}

/** 节点去重：按 server+port+protocol 去重，保留首个 */
export function dedupNodes(nodes: NodeInfo[]): { nodes: NodeInfo[]; removed: number } {
  const seen = new Set<string>();
  const out: NodeInfo[] = [];
  for (const n of nodes) {
    const key = `${n.protocol}|${n.server}|${n.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return { nodes: out, removed: nodes.length - out.length };
}

/** 节点重命名：prefix+序号 或 保留原名加序号后缀 */
export function renameNodes(nodes: NodeInfo[], opts: { prefix?: string; mode: 'prefix-seq' | 'keep-seq' | 'prefix-only' }): NodeInfo[] {
  if (!opts.prefix && opts.mode !== 'keep-seq') return nodes;
  return nodes.map((n, i) => {
    const seq = String(i + 1).padStart(2, '0');
    let name = n.name;
    if (opts.mode === 'prefix-seq') name = `${opts.prefix}${seq}`;
    else if (opts.mode === 'keep-seq') name = `${n.name}-${seq}`;
    else if (opts.mode === 'prefix-only') name = `${opts.prefix}${n.name}`;
    return { ...n, name };
  });
}

/** 检测目标格式不支持的协议 */
export function getUnsupported(target: string, nodes: NodeInfo[]): { protocol: string; count: number }[] {
  // Surge/Loon/QuantumultX 不原生支持 vless
  const unsupportedMap: Record<string, string[]> = {
    surge: ['vless'],
    loon: ['vless'],
    quantumultx: ['vless'],
  };
  const list = unsupportedMap[target] || [];
  if (list.length === 0) return [];
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (list.includes(n.protocol)) counts.set(n.protocol, (counts.get(n.protocol) || 0) + 1);
  }
  return [...counts.entries()].map(([protocol, count]) => ({ protocol, count }));
}

// ==================== 配置规则（subconverter ini 兼容） ====================

export interface SubConfig {
  groups: { name: string; type: string; opts: string[] }[];   // proxy-groups 定义
  rulesets: { tag: string; url: string }[];                    // 远程规则集
  customRules: string[];                                        // 自定义规则行
}

/** 默认配置（内置模板） */
export const DEFAULT_CONFIG: SubConfig = {
  groups: [
    { name: '🚀 节点选择', type: 'select', opts: ['♻️ 自动选择', '.*', '🎯 全球直连'] },
    { name: '♻️ 自动选择', type: 'url-test', opts: ['.*', 'http://www.gstatic.com/generate_204', '300,50'] },
    { name: '🌍 国外媒体', type: 'select', opts: ['🚀 节点选择', '.*'] },
    { name: '🍎 苹果服务', type: 'select', opts: ['🎯 全球直连', '🚀 节点选择'] },
    { name: '🤖 AI 服务', type: 'select', opts: ['🚀 节点选择', '.*'] },
    { name: 'Ⓜ️ 微软服务', type: 'select', opts: ['🎯 全球直连', '🚀 节点选择'] },
    { name: '📲 电报信息', type: 'select', opts: ['🚀 节点选择', '.*'] },
    { name: '🎯 全球直连', type: 'select', opts: ['DIRECT', '🚀 节点选择'] },
    { name: '🛑 广告拦截', type: 'select', opts: ['REJECT', 'DIRECT'] },
    { name: '🐟 漏网之鱼', type: 'select', opts: ['🚀 节点选择', '🎯 全球直连'] },
  ],
  rulesets: [],
  customRules: [
    // 本地/直连
    'DOMAIN-SUFFIX,local,DIRECT',
    'IP-CIDR,127.0.0.0/8,DIRECT',
    'IP-CIDR,172.16.0.0/12,DIRECT',
    'IP-CIDR,192.168.0.0/16,DIRECT',
    'IP-CIDR,10.0.0.0/8,DIRECT',
    'IP-CIDR,100.64.0.0/10,DIRECT',
    // 广告拦截
    'DOMAIN-SUFFIX,doubleclick.net,🛑 广告拦截',
    'DOMAIN-SUFFIX,googlesyndication.com,🛑 广告拦截',
    'DOMAIN-SUFFIX,googleadservices.com,🛑 广告拦截',
    'DOMAIN-SUFFIX,google-analytics.com,🛑 广告拦截',
    'DOMAIN-SUFFIX,adnxs.com,🛑 广告拦截',
    'DOMAIN-SUFFIX,adsystem.com,🛑 广告拦截',
    'DOMAIN-KEYWORD,adservice,🛑 广告拦截',
    'DOMAIN-KEYWORD,tracking,🛑 广告拦截',
    // Google 系
    'DOMAIN-SUFFIX,google.com,🚀 节点选择',
    'DOMAIN-SUFFIX,google.com.hk,🚀 节点选择',
    'DOMAIN-SUFFIX,google.co.jp,🚀 节点选择',
    'DOMAIN-SUFFIX,gstatic.com,🚀 节点选择',
    'DOMAIN-SUFFIX,ggpht.com,🚀 节点选择',
    'DOMAIN-SUFFIX,googleapis.com,🚀 节点选择',
    'DOMAIN-SUFFIX,googlevideo.com,🚀 节点选择',
    'DOMAIN-SUFFIX,gmail.com,🚀 节点选择',
    'DOMAIN-SUFFIX,youtube.com,🚀 节点选择',
    'DOMAIN-SUFFIX,ytimg.com,🚀 节点选择',
    'DOMAIN-SUFFIX,youtu.be,🚀 节点选择',
    // AI 服务
    'DOMAIN-SUFFIX,openai.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,chatgpt.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,oaistatic.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,oaiusercontent.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,claude.ai,🤖 AI 服务',
    'DOMAIN-SUFFIX,anthropic.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,gemini.google.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,bard.google.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,copilot.microsoft.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,perplexity.ai,🤖 AI 服务',
    'DOMAIN-SUFFIX,poe.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,midjourney.com,🤖 AI 服务',
    'DOMAIN-SUFFIX,huggingface.co,🤖 AI 服务',
    // Telegram
    'DOMAIN-SUFFIX,telegram.org,📲 电报信息',
    'DOMAIN-SUFFIX,t.me,📲 电报信息',
    'DOMAIN-SUFFIX,tdesktop.com,📲 电报信息',
    'DOMAIN-SUFFIX,telegra.ph,📲 电报信息',
    'IP-CIDR,91.108.4.0/22,📲 电报信息',
    'IP-CIDR,91.108.8.0/22,📲 电报信息',
    'IP-CIDR,91.108.12.0/22,📲 电报信息',
    'IP-CIDR,91.108.16.0/22,📲 电报信息',
    'IP-CIDR,91.108.56.0/22,📲 电报信息',
    'IP-CIDR,149.154.160.0/20,📲 电报信息',
    // 社交媒体
    'DOMAIN-SUFFIX,twitter.com,🚀 节点选择',
    'DOMAIN-SUFFIX,x.com,🚀 节点选择',
    'DOMAIN-SUFFIX,twimg.com,🚀 节点选择',
    'DOMAIN-SUFFIX,t.co,🚀 节点选择',
    'DOMAIN-SUFFIX,facebook.com,🚀 节点选择',
    'DOMAIN-SUFFIX,fbcdn.net,🚀 节点选择',
    'DOMAIN-SUFFIX,instagram.com,🚀 节点选择',
    'DOMAIN-SUFFIX,cdninstagram.com,🚀 节点选择',
    'DOMAIN-SUFFIX,whatsapp.com,🚀 节点选择',
    'DOMAIN-SUFFIX,whatsapp.net,🚀 节点选择',
    'DOMAIN-SUFFIX,discord.com,🚀 节点选择',
    'DOMAIN-SUFFIX,discordapp.com,🚀 节点选择',
    'DOMAIN-SUFFIX,discordapp.net,🚀 节点选择',
    'DOMAIN-SUFFIX,reddit.com,🚀 节点选择',
    'DOMAIN-SUFFIX,redd.it,🚀 节点选择',
    'DOMAIN-SUFFIX,redditmedia.com,🚀 节点选择',
    // 国外媒体
    'DOMAIN-SUFFIX,netflix.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,nflxvideo.net,🌍 国外媒体',
    'DOMAIN-SUFFIX,netflix.net,🌍 国外媒体',
    'DOMAIN-SUFFIX,disney.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,disneyplus.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,disney-plus.net,🌍 国外媒体',
    'DOMAIN-SUFFIX,dssott.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,hbomax.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,hbonow.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,hulu.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,hulustream.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,primevideo.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,amazonvideo.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,twitch.tv,🌍 国外媒体',
    'DOMAIN-SUFFIX,twitchcdn.net,🌍 国外媒体',
    'DOMAIN-SUFFIX,spotify.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,scdn.co,🌍 国外媒体',
    'DOMAIN-SUFFIX,tiktokv.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,tiktokcdn.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,pixiv.net,🌍 国外媒体',
    'DOMAIN-SUFFIX,pximg.net,🌍 国外媒体',
    'DOMAIN-SUFFIX,bilibili.com,🌍 国外媒体',
    'DOMAIN-SUFFIX,hbomaxcdn.com,🌍 国外媒体',
    // 苹果服务
    'DOMAIN-SUFFIX,apple.com,🍎 苹果服务',
    'DOMAIN-SUFFIX,icloud.com,🍎 苹果服务',
    'DOMAIN-SUFFIX,icloud-content.com,🍎 苹果服务',
    'DOMAIN-SUFFIX,mzstatic.com,🍎 苹果服务',
    'DOMAIN-SUFFIX,apple-cloudkit.com,🍎 苹果服务',
    'DOMAIN-SUFFIX,apple-livephotoskit.com,🍎 苹果服务',
    'DOMAIN-SUFFIX,apple-mapkit.com,🍎 苹果服务',
    'DOMAIN-KEYWORD,apple,🍎 苹果服务',
    // 微软服务
    'DOMAIN-SUFFIX,microsoft.com,Ⓜ️ 微软服务',
    'DOMAIN-SUFFIX,microsoftonline.com,Ⓜ️ 微软服务',
    'DOMAIN-SUFFIX,microsoftazure.com,Ⓜ️ 微软服务',
    'DOMAIN-SUFFIX,windows.net,Ⓜ️ 微软服务',
    'DOMAIN-SUFFIX,office.com,Ⓜ️ 微软服务',
    'DOMAIN-SUFFIX,office365.com,Ⓜ️ 微软服务',
    'DOMAIN-SUFFIX,live.com,Ⓜ️ 微软服务',
    'DOMAIN-SUFFIX,bing.com,Ⓜ️ 微软服务',
    'DOMAIN-SUFFIX,msftconnecttest.com,Ⓜ️ 微软服务',
    'DOMAIN-KEYWORD,microsoft,Ⓜ️ 微软服务',
    // 开发者
    'DOMAIN-SUFFIX,github.com,🚀 节点选择',
    'DOMAIN-SUFFIX,githubusercontent.com,🚀 节点选择',
    'DOMAIN-SUFFIX,githubassets.com,🚀 节点选择',
    'DOMAIN-SUFFIX,github.io,🚀 节点选择',
    'DOMAIN-SUFFIX,gitlab.com,🚀 节点选择',
    'DOMAIN-SUFFIX,gitlab-cdn.net,🚀 节点选择',
    'DOMAIN-SUFFIX,npmjs.com,🚀 节点选择',
    'DOMAIN-SUFFIX,npmjs.org,🚀 节点选择',
    'DOMAIN-SUFFIX,docker.com,🚀 节点选择',
    'DOMAIN-SUFFIX,docker.io,🚀 节点选择',
    'DOMAIN-SUFFIX,stackoverflow.com,🚀 节点选择',
    'DOMAIN-SUFFIX,stackexchange.com,🚀 节点选择',
    'DOMAIN-SUFFIX,medium.com,🚀 节点选择',
    'DOMAIN-SUFFIX,dev.to,🚀 节点选择',
    // 兜底
    'GEOIP,CN,🎯 全球直连',
    'MATCH,🐟 漏网之鱼',
  ],
};

/** 解析 subconverter ini 配置为 SubConfig */
export function parseConfigIni(ini: string): SubConfig {
  const cfg: SubConfig = { groups: [], rulesets: [], customRules: [] };
  const lines = ini.split(/\r?\n/);
  let section = '';
  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1).toLowerCase(); continue; }
    if (section === 'custom_proxy_group') {
      // 格式：name`type`opt1`opt2`...
      const parts = line.split('`');
      if (parts.length >= 2) cfg.groups.push({ name: parts[0], type: parts[1], opts: parts.slice(2) });
    } else if (section === 'ruleset') {
      // 格式：tag,url  或  tag,url,target（subconverter 用 , 分隔）
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length >= 2) cfg.rulesets.push({ tag: parts[0], url: parts[1] });
    } else if (section === 'custom_rule') {
      cfg.customRules.push(line);
    }
  }
  return cfg;
}

/** 展开配置的 proxy-groups：把 opts 中的正则 `.*` 等替换为实际节点名 */
function expandGroups(cfg: SubConfig, nodeNames: string[]): Record<string, unknown>[] {
  const groupNames = new Set(cfg.groups.map((g) => g.name));
  return cfg.groups.map((g) => {
    const proxies: string[] = [];
    for (const opt of g.opts) {
      if (opt === 'DIRECT') { proxies.push('DIRECT'); continue; }
      if (opt === 'REJECT') { proxies.push('REJECT'); continue; }
      if (opt.startsWith('http') || /^\d+,\d+$/.test(opt) || opt === '') continue; // url-test 参数跳过
      // subconverter 语法：[]xxx = 组引用，().* 或正则 = 节点匹配
      if (opt.startsWith('[]')) {
        // 组引用：去掉 [] 前缀，引用其他组名
        const refName = opt.slice(2);
        if (groupNames.has(refName)) proxies.push(refName);
        else if (refName === 'DIRECT') proxies.push('DIRECT');
        else if (refName === 'REJECT') proxies.push('REJECT');
        continue;
      }
      if (opt.startsWith('(') && opt.endsWith(')')) {
        // 正则匹配节点
        try { const re = new RegExp(opt.slice(1, -1)); proxies.push(...nodeNames.filter((n) => re.test(n))); } catch { }
        continue;
      }
      if (opt === '.*') { proxies.push(...nodeNames); continue; }
      // 普通字符串：若匹配现有组名则引用，否则尝试当正则匹配节点
      if (groupNames.has(opt)) { proxies.push(opt); continue; }
      try { const re = new RegExp(opt); const matched = nodeNames.filter((n) => re.test(n)); if (matched.length) proxies.push(...matched); else proxies.push(opt); } catch { proxies.push(opt); }
    }
    const group: Record<string, unknown> = { name: g.name, type: g.type, proxies: proxies.length ? [...new Set(proxies)] : nodeNames };
    if (g.type === 'url-test' || g.type === 'fallback') {
      const url = g.opts.find((o) => o.startsWith('http')) || 'http://www.gstatic.com/generate_204';
      const it = g.opts.find((o) => /^\d+,\d+$/.test(o));
      group.url = url;
      group.interval = it ? parseInt(it.split(',')[0]) : 300;
      group.tolerance = it ? parseInt(it.split(',')[1]) : 50;
    }
    return group;
  });
}

/** 构建规则列表：自定义规则 + 远程规则集引用 */
function buildRules(cfg: SubConfig): { rules: string[]; ruleProviders: Record<string, unknown>[] } {
  const rules: string[] = [];
  const ruleProviders: Record<string, unknown>[] = [];
  // 远程规则集转为 rule-providers + RULE-SET 规则
  for (const rs of cfg.rulesets) {
    const tag = rs.tag.replace(/[^a-zA-Z0-9_-]/g, '_');
    const isYaml = rs.url.endsWith('.yaml') || rs.url.endsWith('.yml');
    ruleProviders.push({
      tag,
      type: 'http',
      behavior: 'classical',
      format: isYaml ? 'yaml' : 'text',
      url: rs.url,
      interval: 86400,
      path: `./ruleset/${tag}.${isYaml ? 'yaml' : 'txt'}`,
    });
    rules.push(`RULE-SET,${tag},${rs.tag.includes(',') ? rs.tag.split(',')[2] || '🚀 节点选择' : '🚀 节点选择'}`);
  }
  // 自定义规则
  rules.push(...cfg.customRules);
  return { rules, ruleProviders };
}


export function toClash(nodes: NodeInfo[], subName = '订阅转换', config: SubConfig = DEFAULT_CONFIG): string {
  const nodeNames = nodes.map((n) => n.name);
  const proxies = nodes.map((n) => {
    const name = yamlStr(n.name);
    const base: Record<string, unknown> = { name };
    if (n.protocol === 'vless') {
      base.type = 'vless';
      base.server = n.server;
      base.port = n.port;
      base.uuid = n.uuid;
      base.tls = n.tls;
      if (n.network && n.network !== 'tcp') base.network = n.network;
      if (n.sni) base.servername = n.sni;
      if (n.flow) base.flow = n.flow;
      if (n.alpn) base.alpn = n.alpn.split(',');
      if (n.pbk) { base['reality-opts'] = { 'public-key': n.pbk, 'short-id': n.sid || '' }; }
      if (n.network === 'ws') {
        base['ws-opts'] = { path: n.path || '/', headers: { Host: n.host || n.sni || n.server } };
        if (n.params?.['ed']) (base['ws-opts'] as Record<string, unknown>)['max-early-data'] = parseInt(n.params['ed']) || 2048;
      } else if (n.network === 'grpc') {
        base['grpc-opts'] = { 'grpc-service-name': n.params?.serviceName || '' };
      }
    } else if (n.protocol === 'vmess') {
      base.type = 'vmess';
      base.server = n.server;
      base.port = n.port;
      base.uuid = n.uuid;
      base.alterId = n.alterId || 0;
      base.cipher = 'auto';
      base.tls = n.tls;
      if (n.network && n.network !== 'tcp') base.network = n.network;
      if (n.sni) base.servername = n.sni;
      if (n.network === 'ws') {
        base['ws-opts'] = { path: n.path || '/', headers: { Host: n.host || n.sni || n.server } };
      }
    } else if (n.protocol === 'trojan') {
      base.type = 'trojan';
      base.server = n.server;
      base.port = n.port;
      base.password = n.password;
      base.sni = n.sni || n.server;
      if (n.network && n.network !== 'tcp') {
        base.network = n.network;
        if (n.network === 'ws') {
          base['ws-opts'] = { path: n.path || '/', headers: { Host: n.host || n.sni } };
        }
      }
      if (n.alpn) base['alpn'] = n.alpn.split(',');
    } else if (n.protocol === 'ss') {
      base.type = 'ss';
      base.server = n.server;
      base.port = n.port;
      base.cipher = n.method;
      base.password = n.password;
    }
    return base;
  });

  const proxyList = proxies.map((p) => yamlListItem(p, 1)).join('\n');
  const groups = expandGroups(config, nodeNames);
  const { rules, ruleProviders } = buildRules(config);
  const ruleProvidersYaml = ruleProviders.length ? `\nrule-providers:\n${ruleProviders.map((rp) => yamlListItem(rp, 1)).join('\n')}\n` : '';
  const rulesYaml = rules.map((r) => `  - ${r}`).join('\n');

  return `# ${subName} - Clash 配置
# 生成时间: ${new Date().toISOString()}

mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: true
unified-delay: true
external-controller: 127.0.0.1:9090
global-ua: clash.meta

dns:
  enable: true
  ipv6: true
  listen: 0.0.0.0:53
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - '+.lan'
    - '+.local'
    - 'time.*.com'
    - 'ntp.*.com'
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  fallback:
    - https://1.1.1.1/dns-query
    - https://8.8.8.8/dns-query

proxies:
${proxyList}

proxy-groups:
${groups.map((g) => yamlListItem(g, 1)).join('\n')}
${ruleProvidersYaml}
rules:
${rulesYaml}
`;
}

/** 转换为 sing-box JSON */
export function toSingbox(nodes: NodeInfo[], subName = '订阅转换'): string {
  const outbounds = nodes.map((n) => {
    const ob: Record<string, unknown> = { tag: n.name, type: n.protocol, server: n.server, server_port: n.port };
    if (n.protocol === 'vless') {
      ob.uuid = n.uuid;
      ob.tls = { enabled: n.tls, server_name: n.sni || n.server, insecure: false };
      if (n.alpn) ob.tls.alpn = n.alpn.split(',');
      if (n.pbk) { ob.tls.reality = { enabled: true, public_key: n.pbk, short_id: n.sid || '' }; }
      if (n.network === 'ws') {
        ob.transport = { type: 'ws', path: n.path || '/', headers: { Host: n.host || n.sni || n.server } };
      } else if (n.network === 'grpc') {
        ob.transport = { type: 'grpc', service_name: n.params?.serviceName || '' };
      }
      if (n.flow) ob.flow = n.flow;
    } else if (n.protocol === 'vmess') {
      ob.uuid = n.uuid;
      ob.alter_id = n.alterId || 0;
      ob.security = 'auto';
      ob.tls = { enabled: n.tls, server_name: n.sni || n.server, insecure: false };
      if (n.network === 'ws') {
        ob.transport = { type: 'ws', path: n.path || '/', headers: { Host: n.host || n.sni || n.server } };
      }
    } else if (n.protocol === 'trojan') {
      ob.password = n.password;
      ob.tls = { enabled: true, server_name: n.sni || n.server, insecure: false };
      if (n.network === 'ws') {
        ob.transport = { type: 'ws', path: n.path || '/', headers: { Host: n.host || n.sni } };
      }
    } else if (n.protocol === 'ss') {
      ob.method = n.method;
      ob.password = n.password;
    }
    return ob;
  });

  const config = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'dns_remote', address: 'https://1.1.1.1/dns-query', detour: 'proxy' },
        { tag: 'dns_direct', address: 'https://223.5.5.5/dns-query', detour: 'direct' },
        { tag: 'dns_block', address: 'rcode://success' },
      ],
      rules: [
        { outbound: 'any', server: 'dns_direct' },
        { rule_set: 'geosite-category-ads-all', server: 'dns_block' },
      ],
    },
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'], auto_route: true },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 7890 },
    ],
    outbounds: [
      { type: 'selector', tag: 'proxy', outbounds: ['auto', ...nodes.map((n) => n.name)], default: 'auto' },
      { type: 'urltest', tag: 'auto', outbounds: nodes.map((n) => n.name), url: 'http://www.gstatic.com/generate_204', interval: '5m', tolerance: 50 },
      ...outbounds,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
      { type: 'dns', tag: 'dns-out' },
    ],
    route: {
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: 'geosite-category-ads-all', outbound: 'block' },
      ],
      rule_set: [
        { tag: 'geosite-category-ads-all', type: 'remote', format: 'binary', url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs', download_detour: 'direct' },
      ],
      final: 'proxy',
      auto_detect_interface: true,
    },
  };
  return JSON.stringify(config, null, 2);
}

/** 转换为 v2ray base64（合并多链接 base64 编码） */
export function toV2ray(nodes: NodeInfo[]): string {
  const lines = nodes.map((n) => toLink(n)).filter(Boolean);
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

/** NodeInfo 转回链接 */
export function toLink(n: NodeInfo): string {
  if (n.protocol === 'vless') {
    const p = new URLSearchParams();
    if (n.network && n.network !== 'tcp') p.set('type', n.network);
    p.set('security', n.pbk ? 'reality' : (n.tls ? 'tls' : 'none'));
    if (n.sni) p.set('sni', n.sni);
    if (n.host) p.set('host', n.host);
    if (n.path) p.set('path', encodeURIComponent(n.path));
    if (n.alpn) p.set('alpn', n.alpn);
    if (n.fp) p.set('fp', n.fp);
    if (n.pbk) p.set('pbk', n.pbk);
    if (n.sid) p.set('sid', n.sid);
    if (n.flow) p.set('flow', n.flow);
    return `vless://${n.uuid}@${n.server}:${n.port}?${p.toString()}#${encodeURIComponent(n.name)}`;
  }
  if (n.protocol === 'trojan') {
    const p = new URLSearchParams();
    if (n.network && n.network !== 'tcp') p.set('type', n.network);
    if (n.sni) p.set('sni', n.sni);
    if (n.host) p.set('host', n.host);
    return `trojan://${encodeURIComponent(n.password || '')}@${n.server}:${n.port}?${p.toString()}#${encodeURIComponent(n.name)}`;
  }
  if (n.protocol === 'ss') {
    const cred = Buffer.from(`${n.method}:${n.password}`, 'utf8').toString('base64url');
    return `ss://${cred}@${n.server}:${n.port}#${encodeURIComponent(n.name)}`;
  }
  return '';
}

/** YAML 字符串转义 */
function yamlStr(s: string): string {
  if (/[:#{}\[\],&*?|<>=!%@`"\n]/.test(s)) return JSON.stringify(s);
  return s;
}

/** 对象作为 YAML 列表项输出：首行 `- key: val`，后续行对齐到 `- ` 后 */
function yamlListItem(obj: Record<string, unknown>, indent = 0): string {
  const pad = '  '.repeat(indent);
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return `${pad}- {}`;
  const cont = pad + '  '; // 列表项内容缩进（- 后 2 空格）
  const lines: string[] = [];
  entries.forEach(([k, v], i) => {
    const prefix = i === 0 ? `${pad}- ` : cont;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      lines.push(`${prefix}${k}:`);
      for (const item of v) {
        if (typeof item === 'object' && item !== null) {
          lines.push(`${cont}- ` + yamlObj(item as Record<string, unknown>, indent + 2).trimStart());
        } else {
          lines.push(`${cont}- ${yamlStr(String(item))}`);
        }
      }
    } else if (typeof v === 'object') {
      lines.push(`${prefix}${k}:`);
      lines.push(yamlObj(v as Record<string, unknown>, indent + 2));
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${prefix}${k}: ${v}`);
    } else {
      lines.push(`${prefix}${k}: ${yamlStr(String(v))}`);
    }
  });
  return lines.join('\n');
}

/** 对象转 YAML（简易） */
function yamlObj(obj: Record<string, unknown>, indent = 0): string {
  const pad = '  '.repeat(indent);
  const childPad = '  '.repeat(indent + 1);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      parts.push(`${pad}${k}:`);
      for (const item of v) {
        if (typeof item === 'object' && item !== null) {
          parts.push(`${childPad}- ` + yamlObj(item as Record<string, unknown>, indent + 2).trimStart());
        } else {
          parts.push(`${childPad}- ${yamlStr(String(item))}`);
        }
      }
    } else if (typeof v === 'object') {
      parts.push(`${pad}${k}:`);
      parts.push(yamlObj(v as Record<string, unknown>, indent + 1));
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      parts.push(`${pad}${k}: ${v}`);
    } else {
      parts.push(`${pad}${k}: ${yamlStr(String(v))}`);
    }
  }
  return parts.join('\n');
}

// ==================== 更多客户端格式 ====================

/** 转换为 Surge 配置（含 ss/vless/trojan；Surge 不原生支持 vless，降级为 ss 或注释） */
export function toSurge(nodes: NodeInfo[], subName = '订阅转换'): string {
  const proxies: string[] = [];
  for (const n of nodes) {
    const name = n.name.replace(/[,=:]/g, ' ');
    if (n.protocol === 'ss') {
      proxies.push(`${name} = ss, ${n.server}, ${n.port}, encrypt-method=${n.method}, password=${n.password}, udp-relay=true`);
    } else if (n.protocol === 'trojan') {
      proxies.push(`${name} = trojan, ${n.server}, ${n.port}, password=${n.password}, sni=${n.sni || n.server}${n.network === 'ws' ? `, ws=true, ws-path=${n.path || '/'}, ws-headers=Host:${n.host || n.sni}` : ''}`);
    } else if (n.protocol === 'vmess') {
      proxies.push(`${name} = vmess, ${n.server}, ${n.port}, username=${n.uuid}, tls=${n.tls}, sni=${n.sni || n.server}${n.network === 'ws' ? `, ws=true, ws-path=${n.path || '/'}, ws-headers=Host:${n.host || n.sni}` : ''}`);
    }
    // vless Surge 不原生支持，跳过
  }
  return `# ${subName} - Surge 配置
# 生成时间: ${new Date().toISOString()}

[General]
loglevel = notify
dns-server = 223.5.5.5, 119.29.29.29
skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local
ipv6 = true

[Proxy]
DIRECT = direct
${proxies.join('\n')}

[Proxy Group]
🚀 节点选择 = select, ♻️ 自动选择, ${nodes.map((n) => n.name.replace(/[,=:]/g, ' ')).join(', ')}, 🎯 全球直连
♻️ 自动选择 = url-test, ${nodes.map((n) => n.name.replace(/[,=:]/g, ' ')).join(', ')}, url=http://www.gstatic.com/generate_204, interval=300
🎯 全球直连 = select, DIRECT, 🚀 节点选择
🛑 广告拦截 = select, REJECT, DIRECT
🐟 漏网之鱼 = select, 🚀 节点选择, 🎯 全球直连

[Rule]
DOMAIN-SUFFIX,local,DIRECT
IP-CIDR,127.0.0.0/8,DIRECT
DOMAIN-SUFFIX,google.com,🚀 节点选择
DOMAIN-SUFFIX,youtube.com,🚀 节点选择
DOMAIN-SUFFIX,github.com,🚀 节点选择
DOMAIN-SUFFIX,openai.com,🚀 节点选择
DOMAIN-SUFFIX,claude.ai,🚀 节点选择
DOMAIN-SUFFIX,telegram.org,📲 电报信息
DOMAIN-SUFFIX,t.me,📲 电报信息
DOMAIN-SUFFIX,netflix.com,🌍 国外媒体
DOMAIN-SUFFIX,disney.com,🌍 国外媒体
GEOIP,CN,🎯 全球直连
FINAL,🐟 漏网之鱼
`;
}

/** 转换为 QuantumultX 配置 */
export function toQuantumultX(nodes: NodeInfo[]): string {
  const server: string[] = [];
  const filter: string[] = [];
  for (const n of nodes) {
    const name = n.name.replace(/[,=:]/g, ' ');
    if (n.protocol === 'ss') {
      server.push(`shadowsocks=${n.server}:${n.port}, method=${n.method}, password=${n.password}, tag=${name}, udp-relay=true`);
    } else if (n.protocol === 'vmess') {
      const obfs = n.network === 'ws' ? `, obfs=ws, obfs-path=${n.path || '/'}, obfs-header=Host:${n.host || n.sni}` : '';
      server.push(`vmess=${n.server}:${n.port}, method=none, password=${n.uuid}, tag=${name}${obfs}, tls=${n.tls}, tls-verification=false, tls-host=${n.sni || n.server}`);
    } else if (n.protocol === 'trojan') {
      server.push(`trojan=${n.server}:${n.port}, password=${n.password}, tag=${name}, tls-verification=false, tls-host=${n.sni || n.server}`);
    }
    filter.push(name);
  }
  return `# QuantumultX 配置
# 生成时间: ${new Date().toISOString()}

[server_local]
${server.join('\n')}

[server_remote]

[policy]
static=🚀 节点选择, ${filter.join(',')}, img=🚀
static=🎯 全球直连, DIRECT, img=🎯
static=🛑 广告拦截, REJECT, img=🛑
available=♻️ 自动选择, ${filter.join(',')}, img=♻️
static=🐟 漏网之鱼, 🚀 节点选择, 🎯 全球直连, img=🐟

[filter_local]
domain-suffix, local, direct
ip-cidr, 127.0.0.0/8, direct
domain-suffix, google.com, 🚀 节点选择
domain-suffix, youtube.com, 🚀 节点选择
domain-suffix, github.com, 🚀 节点选择
domain-suffix, openai.com, 🚀 节点选择
domain-suffix, claude.ai, 🚀 节点选择
domain-suffix, telegram.org, 🚀 节点选择
domain-suffix, netflix.com, 🚀 节点选择
geoip, cn, 🎯 全球直连
final, 🐟 漏网之鱼

[rewrite_local]

[mitm]
`;
}

/** 转换为 Loon 配置 */
export function toLoon(nodes: NodeInfo[], subName = '订阅转换'): string {
  const proxies: string[] = [];
  for (const n of nodes) {
    const name = n.name.replace(/[,=:]/g, ' ');
    if (n.protocol === 'ss') {
      proxies.push(`${name} = Shadowsocks,${n.server},${n.port},${n.method},"${n.password}",udp=true`);
    } else if (n.protocol === 'trojan') {
      proxies.push(`${name} = Trojan,${n.server},${n.port},"${n.password}",sni=${n.sni || n.server}`);
    } else if (n.protocol === 'vmess') {
      proxies.push(`${name} = VMess,${n.server},${n.port},${n.uuid},tls=${n.tls},sni=${n.sni || n.server}`);
    }
  }
  return `# ${subName} - Loon 配置
# 生成时间: ${new Date().toISOString()}

[General]
skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local
dns-server = 223.5.5.5, 119.29.29.29

[Proxy]
DIRECT = DIRECT
${proxies.join('\n')}

[Proxy Group]
🚀 节点选择 = select, ♻️ 自动选择, ${nodes.map((n) => n.name.replace(/[,=:]/g, ' ')).join(',')}, 🎯 全球直连
♻️ 自动选择 = url-test, ${nodes.map((n) => n.name.replace(/[,=:]/g, ' ')).join(',')}, url=http://www.gstatic.com/generate_204, interval=300
🎯 全球直连 = select, DIRECT, 🚀 节点选择
🛑 广告拦截 = select, REJECT, DIRECT
🐟 漏网之鱼 = select, 🚀 节点选择, 🎯 全球直连

[Rule]
DOMAIN-SUFFIX,local,DIRECT
IP-CIDR,127.0.0.0/8,DIRECT
DOMAIN-SUFFIX,google.com,🚀 节点选择
DOMAIN-SUFFIX,youtube.com,🚀 节点选择
DOMAIN-SUFFIX,github.com,🚀 节点选择
DOMAIN-SUFFIX,openai.com,🚀 节点选择
DOMAIN-SUFFIX,telegram.org,🚀 节点选择
DOMAIN-SUFFIX,netflix.com,🚀 节点选择
GEOIP,CN,🎯 全球直连
FINAL,🐟 漏网之鱼
`;
}

/** 转换为原始链接（mixed，每行一个节点链接，不做 base64） */
export function toMixed(nodes: NodeInfo[]): string {
  return nodes.map((n) => toLink(n)).filter(Boolean).join('\n');
}

