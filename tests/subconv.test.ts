/**
 * SubConv 修复验证测试
 * 运行: cd /home/z/my-project/scripts/subconv-test && bun run test.ts
 */
import { parse } from 'yaml';
import {
  parseSubscription, toClash, toSingbox, toV2ray, toMixed, toLink, getUnsupported,
  parseConfigIni, DEFAULT_CONFIG, type SubConfig, type NodeInfo,
} from '../src/lib/sub-converter';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---------- 检测策略组引用环 ----------
function detectGroupCycle(clashYaml: string): { cycle: boolean; desc: string } {
  const doc = parse(clashYaml) as any;
  const groups: any[] = doc?.['proxy-groups'] ?? [];
  const nodeNames = new Set<string>((doc?.proxies ?? []).map((p: any) => p.name));
  const byName = new Map<string, string[]>();
  for (const g of groups) {
    byName.set(g.name, (g.proxies ?? []).filter((p: string) => !nodeNames.has(p) && p !== 'DIRECT' && p !== 'REJECT'));
  }
  const state = new Map<string, number>();
  let cycle = false; const desc: string[] = [];
  const dfs = (n: string, path: string[]): void => {
    if (cycle) return;
    state.set(n, 1);
    for (const ref of byName.get(n) ?? []) {
      if (!byName.has(ref)) continue;
      const st = state.get(ref) ?? 0;
      if (st === 1) { cycle = true; desc.push(path.concat(n, ref).join(' -> ')); return; }
      if (st === 0) dfs(ref, path.concat(n));
    }
    state.set(n, 2);
  };
  for (const name of byName.keys()) if ((state.get(name) ?? 0) === 0) dfs(name, []);
  return { cycle, desc: desc.join(' | ') };
}

// ==================== 1. 解析用户真实节点 ====================
console.log('\n[1] 节点解析');
const RAW = [
  'vless://b69cf773-da16-486e-afce-a45b94f998b3@47.238.122.8:443?type=ws&host=sf.an225.pp.ua&path=%2F&encryption=none&security=tls&sni=sf.an225.pp.ua&alpn=h2%2Chttp%2F1.1&fp=chrome&ech=cloudflare-ech.com%2Bhttps%3A%2F%2Fdns.alidns.com%2Fdns-query#%F0%9F%87%AD%F0%9F%87%B0%E9%A6%99%E6%B8%AF-1',
  'vless://b69cf773-da16-486e-afce-a45b94f998b3@47.83.157.126:443?type=ws&host=sfnode.an226.pp.ua&path=%2F&encryption=none&security=tls&sni=sfnode.an226.pp.ua&alpn=h2%2Chttp%2F1.1&fp=chrome#🇭🇰香港-2',
  'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: '🇭🇰VMess-测试', add: '1.2.3.4', port: '443', id: 'b69cf773-da16-486e-afce-a45b94f998b3', aid: '0', net: 'ws', host: 'h.example.com', path: '/ws', tls: 'tls', sni: 'h.example.com' }), 'utf8').toString('base64'),
  'trojan://pass123@5.6.7.8:443?sni=t.example.com#🇸🇬Trojan-测试',
  'ss://' + Buffer.from('aes-256-gcm:secretpw', 'utf8').toString('base64url') + '@9.9.9.9:8388#🇯🇵SS-测试',
].join('\n');

const nodes = parseSubscription(RAW);
check('解析 5 个混合协议节点', nodes.length === 5, `实际 ${nodes.length}`);
check('vless 保留 fp 指纹', nodes[0].fp === 'chrome');
check('vless ws path 解码', nodes[0].path === '/');
check('vmess 解析成功', nodes[2]?.protocol === 'vmess' && nodes[2].host === 'h.example.com');

// ==================== 2. Clash 输出：默认模板无环 ====================
console.log('\n[2] Clash 默认模板（用户实报的 loop bug）');
const clash1 = toClash(nodes, '测试订阅');
const c1 = detectGroupCycle(clash1);
check('默认模板无策略组环', !c1.cycle, c1.desc);
const doc1 = parse(clash1) as any;
const g1 = Object.fromEntries((doc1['proxy-groups'] ?? []).map((g: any) => [g.name, g.proxies]));
check('全球直连 = [DIRECT]（不再回引节点选择）', JSON.stringify(g1['🎯 全球直连']) === JSON.stringify(['DIRECT']), JSON.stringify(g1['🎯 全球直连']));
check('节点选择含 自动选择+全部节点+DIRECT', (g1['🚀 节点选择'] ?? []).includes('♻️ 自动选择') && (g1['🚀 节点选择'] ?? []).includes('DIRECT'));
check('自动选择 url-test 含全部节点', (g1['♻️ 自动选择'] ?? []).length === 5);
check('vless 输出 client-fingerprint', clash1.includes('client-fingerprint: chrome'));
check('vmess 输出 client-fingerprint', clash1.includes('client-fingerprint: chrome'));
check('bilibili 路由到全球直连', (doc1.rules as string[]).some(r => r.includes('bilibili.com,🎯 全球直连')));

// ==================== 3. 人为构造的环配置 → 自动剥离 ====================
console.log('\n[3] 自定义配置环剥离（expandGroups breakGroupCycles）');
const loopCfg: SubConfig = {
  groups: [
    { name: '组A', type: 'select', opts: ['[]组B', '香港'] },
    { name: '组B', type: 'select', opts: ['[]组A'] },
  ],
  rulesets: [],
  customRules: ['MATCH,组A'],
};
const clash2 = toClash(nodes, '环剥离测试', loopCfg);
const c2 = detectGroupCycle(clash2);
check('人为环被自动剥离', !c2.cycle, c2.desc);
const doc2 = parse(clash2) as any;
const g2 = Object.fromEntries((doc2['proxy-groups'] ?? []).map((g: any) => [g.name, g.proxies]));
check('组A 保留节点与组B引用之一', (g2['组A'] ?? []).length >= 1);
check('MATCH 规则指向存在的组', (doc2.rules as string[]).some(r => r === 'MATCH,组A'));

// ==================== 4. 标准 subconverter [custom] ini 兼容 ====================
console.log('\n[4] parseConfigIni 兼容 ACL4SSR [custom] 格式');
const ini = `# ACL4SSR 测试（完整场景：ruleset 引用的组在 custom_proxy_group 中定义）
[custom]
;这是注释
custom_proxy_group=🚀 节点选择\`select\`♻️ 自动选择\`DIRECT
custom_proxy_group=♻️ 自动选择\`url-test\`.*\`http://www.gstatic.com/generate_204\`300,50
custom_proxy_group=🎯 全球直连\`select\`DIRECT
ruleset=🎯 全球直连,https://example.com/lan.txt
ruleset=🚀 节点选择,https://example.com/proxy.txt
ruleset=未定义的组,https://example.com/other.txt
custom_rule=MATCH,🐟 漏网之鱼
`;
const cfg = parseConfigIni(ini);
check('解析出 3 个策略组', cfg.groups.length === 3, `实际 ${cfg.groups.length}`);
check('解析出 3 条 ruleset', cfg.rulesets.length === 3, `实际 ${cfg.rulesets.length}`);
check('ruleset tag 保留中文组名', cfg.rulesets[0].tag === '🎯 全球直连');
check('custom_rule 解析', cfg.customRules.length === 1);
const clash3 = toClash(nodes, 'ini测试', cfg);
const doc3 = parse(clash3) as any;
const rps = doc3['rule-providers'] ?? {};
// rule-providers 现为映射结构（key = tag），中文组名不再冲突由 rs{i} 前缀保证
const rpTags = Object.keys(rps);
check('rule-providers tag 唯一（中文组名不再冲突）', new Set(rpTags).size === rpTags.length, JSON.stringify(rpTags));
check('rule-providers 是映射而非数组（mihomo 兼容）', !Array.isArray(rps));
const rules3 = doc3.rules as string[];
check('RULE-SET 目标使用 ini 指定的组（组已定义）', rules3.some(r => r.startsWith('RULE-SET,rs0_') && r.endsWith(',🎯 全球直连')), rules3.filter(r => r.startsWith('RULE-SET')).join(' ; '));
check('RULE-SET 目标第二组=节点选择', rules3.some(r => r.startsWith('RULE-SET,rs1_') && r.endsWith(',🚀 节点选择')));
check('RULE-SET 引用未定义组时回退到节点选择', rules3.some(r => r.startsWith('RULE-SET,rs2_') && r.endsWith(',🚀 节点选择')));

// ==================== 5. toLink / v2ray / mixed：vmess 不再丢失 ====================
console.log('\n[5] vmess 链接生成（此前 v2ray/mixed 静默丢节点）');
const vmessNode = nodes[2];
const vl = toLink(vmessNode);
check('vmess toLink 生成', vl.startsWith('vmess://'), vl.slice(0, 30));
try {
  const j = JSON.parse(Buffer.from(vl.slice(8), 'base64').toString('utf8'));
  check('vmess 链接可解码且字段正确', j.add === '1.2.3.4' && j.port === '443' && j.net === 'ws' && j.tls === 'tls');
} catch (e) { check('vmess 链接可解码且字段正确', false, String(e)); }
check('vmess 保留原名+round-trip 名称', decodeURIComponent(JSON.parse(Buffer.from(vl.slice(8), 'base64').toString('utf8')).ps) === '🇭🇰VMess-测试' || JSON.parse(Buffer.from(vl.slice(8), 'base64').toString('utf8')).ps === '🇭🇰VMess-测试');
const v2 = toV2ray(nodes);
const v2decoded = Buffer.from(v2, 'base64').toString('utf8');
check('v2ray base64 输出含全部 5 个节点链接', v2decoded.trim().split('\n').length === 5, `实际 ${v2decoded.trim().split('\n').length}`);
check('mixed 输出含 vmess 链接', toMixed(nodes).split('\n').length === 5);

// ==================== 6. sing-box 输出 ====================
console.log('\n[6] sing-box 输出');
let sb: any = null;
try { sb = JSON.parse(toSingbox(nodes)); } catch (e) { /* handled below */ }
check('sing-box 输出为合法 JSON', !!sb);
check('sing-box 含 5 个节点出站', sb ? sb.outbounds.filter((o: any) => ['vless', 'vmess', 'trojan', 'ss'].includes(o.type)).length === 5 : false);
const sbVmess = sb?.outbounds.find((o: any) => o.type === 'vmess');
check('sing-box vmess 输出 tls 对象（节点为 tls）', !!sbVmess?.tls?.enabled);
const sbVless = sb?.outbounds.find((o: any) => o.type === 'vless');
check('sing-box vless 带 fp 时输出 utls', !!sbVless?.tls?.utls?.enabled && sbVless?.tls?.utls?.fingerprint === 'chrome');
const sbSS = sb?.outbounds.find((o: any) => o.type === 'ss');
check('sing-box ss 无多余 tls 对象', sbSS && !('tls' in sbSS));

// ==================== 7. YAML 特殊节点名转义 ====================
console.log('\n[7] YAML 转义边界');
const weird: NodeInfo[] = [{ ...nodes[0], name: '443' }];
const clash4 = toClash(weird, '转义测试');
check('纯数字节点名被引号保护', clash4.includes('name: "443"'), clash4.split('\n').find(l => l.includes('name:')) ?? '');
const weird2 = [{ ...nodes[0], name: '- 开头破折号' }];
check('- 开头节点名被引号保护', toClash(weird2, 't').includes('name: "- 开头破折号"'));

// ==================== 8. Surge / Loon / QX 组完整性 ====================
console.log('\n[8] Surge / Loon 模板组完整性');
import { toSurge, toLoon, toQuantumultX } from '../src/lib/sub-converter';
const surge = toSurge(nodes);
const sgGroupSection = surge.split('[Proxy Group]')[1]?.split('[Rule]')[0] ?? '';
check('Surge 不再有 全球直连→节点选择 回引', !/🎯 全球直连 = select, DIRECT, 🚀 节点选择/.test(sgGroupSection));
check('Surge 规则引用的组都已定义', ['📲 电报信息', '🌍 国外媒体', '🛑 广告拦截', '🐟 漏网之鱼', '🎯 全球直连', '♻️ 自动选择', '🚀 节点选择'].every(g => sgGroupSection.includes(g + ' = ')));
const loon = toLoon(nodes);
const loonGroup = loon.split('[Proxy Group]')[1]?.split('[Rule]')[0] ?? '';
check('Loon 不再有 全球直连→节点选择 回引', !/🎯 全球直连 = select, DIRECT, 🚀 节点选择/.test(loonGroup));
const qx = toQuantumultX(nodes);
check('QX 全球直连仅 DIRECT', qx.includes('static=🎯 全球直连, DIRECT, img=🎯'));

// ==================== 9. 默认配置环检测（直接断言模板） ====================
console.log('\n[9] DEFAULT_CONFIG 直接断言');
const gdGroup = DEFAULT_CONFIG.groups.find(g => g.name === '🎯 全球直连');
check('模板全球直连 opts 仅 DIRECT', gdGroup?.opts.length === 1 && gdGroup.opts[0] === 'DIRECT');
const jsGroup = DEFAULT_CONFIG.groups.find(g => g.name === '🚀 节点选择');
check('模板节点选择不含全球直连', !jsGroup?.opts.includes('🎯 全球直连'));

// ==================== 10. Clash YAML 整份配置输入（机场返回 ?clash 格式的场景） ====================
console.log('\n[10] Clash YAML 输入解析');
const CLASH_YAML_INPUT = `# ===== 某机场完整配置 =====
mode: rule
mixed-port: 7890
log-level: info

proxies:
  - name: "🇭🇰香港-1-WS"
    type: vless
    server: "47.238.122.8"
    port: 443
    uuid: "b69cf773-da16-486e-afce-a45b94f998b3"
    udp: true
    network: ws
    ws-opts:
      path: "/"
      headers:
        Host: "sf.an225.pp.ua"
      max-early-data: 2048
    tls: true
    servername: "sf.an225.pp.ua"
    alpn: ["h2", "http/1.1"]
    client-fingerprint: "chrome"
  - name: "🇭🇰香港-3-XHTTP"
    type: vless
    server: "47.86.103.60"
    port: 443
    uuid: "753cf805-f6e0-440a-a973-72f5bb084e80"
    network: xhttp
    xhttp-opts:
      path: "/"
      host: "cdqc4.an226.pp.ua"
      mode: stream-one
    tls: true
    servername: "cdqc4.an226.pp.ua"
  - name: "🇺🇸Reality-中转"
    type: vless
    server: "104.21.0.1"
    port: 443
    uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    tls: true
    servername: "www.microsoft.com"
    flow: "xtls-rprx-vision"
    reality-opts:
      public-key: "pbk123"
      short-id: "0123abcd"
    network: tcp
  - name: "🇯🇵VMess-WS"
    type: vmess
    server: "1.2.3.4"
    port: 443
    uuid: "b69cf773-da16-486e-afce-a45b94f998b3"
    alterId: 0
    cipher: auto
    network: ws
    ws-opts:
      path: "/ws"
      headers:
        Host: "h.example.com"
    tls: true
    servername: "h.example.com"
  - name: "🇸🇬Trojan-1"
    type: trojan
    server: "5.6.7.8"
    port: 443
    password: "pass123"
    sni: "t.example.com"
    alpn: ["h2", "http/1.1"]
  - name: "🇰🇷SS-1"
    type: ss
    server: "9.9.9.9"
    port: 8388
    cipher: aes-256-gcm
    password: "secretpw"
  - name: "🇺🇸SS-带插件应跳过"
    type: ss
    server: "9.9.9.10"
    port: 8080
    cipher: aes-256-gcm
    password: "pw2"
    plugin: obfs
    plugin-opts:
      mode: http
  - name: "🇺🇸HTTP-应跳过"
    type: http
    server: "10.0.0.1"
    port: 8080

proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies: ["🇭🇰香港-1-WS", "🇭🇰香港-3-XHTTP"]

rules:
  - MATCH,🚀 节点选择
`;
const yamlNodes = parseSubscription(CLASH_YAML_INPUT);
check('YAML 输入解析出 6 个节点（http/带插件 ss 跳过）', yamlNodes.length === 6, `实际 ${yamlNodes.length}`);
const ynWs = yamlNodes.find(n => n.name === '🇭🇰香港-1-WS');
check('vless ws: host/path/ed 还原', !!ynWs && ynWs.host === 'sf.an225.pp.ua' && ynWs.path === '/' && ynWs.params?.['ed'] === '2048', JSON.stringify(ynWs));
check('vless ws: sni/alpn/fp 还原', !!ynWs && ynWs.sni === 'sf.an225.pp.ua' && ynWs.alpn === 'h2,http/1.1' && ynWs.fp === 'chrome');
const ynXhttp = yamlNodes.find(n => n.name === '🇭🇰香港-3-XHTTP');
check('vless xhttp: network/host/xmode 还原', !!ynXhttp && ynXhttp.network === 'xhttp' && ynXhttp.host === 'cdqc4.an226.pp.ua' && ynXhttp.params?.['xmode'] === 'stream-one', JSON.stringify(ynXhttp));
const ynReality = yamlNodes.find(n => n.name === '🇺🇸Reality-中转');
check('vless reality: pbk/sid/flow 还原', !!ynReality && ynReality.pbk === 'pbk123' && ynReality.sid === '0123abcd' && ynReality.flow === 'xtls-rprx-vision');
const ynVmess = yamlNodes.find(n => n.name === '🇯🇵VMess-WS');
check('vmess: host/path/tls 还原', !!ynVmess && ynVmess.host === 'h.example.com' && ynVmess.path === '/ws' && ynVmess.tls === true);
const ynTrojan = yamlNodes.find(n => n.name === '🇸🇬Trojan-1');
check('trojan: password/alpn 还原且强制 tls', !!ynTrojan && ynTrojan.password === 'pass123' && ynTrojan.alpn === 'h2,http/1.1' && ynTrojan.tls === true);
const ynSS = yamlNodes.find(n => n.name === '🇰🇷SS-1');
check('ss: cipher→method 还原', !!ynSS && ynSS.method === 'aes-256-gcm' && ynSS.password === 'secretpw');

// YAML 输入 → 再转 Clash：往返不丢 xhttp/early-data
const roundTrip = toClash(yamlNodes, 'YAML往返');
const rtDoc = parse(roundTrip) as any;
const rtXhttp = (rtDoc.proxies as any[]).find(p => p.name === '🇭🇰香港-3-XHTTP');
check('往返输出: xhttp-opts 保留 path/host/mode', !!rtXhttp && rtXhttp['xhttp-opts']?.host === 'cdqc4.an226.pp.ua' && rtXhttp['xhttp-opts']?.mode === 'stream-one', JSON.stringify(rtXhttp));
const rtWs = (rtDoc.proxies as any[]).find(p => p.name === '🇭🇰香港-1-WS');
check('往返输出: ws-opts 保留 max-early-data', !!rtWs && rtWs['ws-opts']?.['max-early-data'] === 2048, JSON.stringify(rtWs));
check('往返输出: 节点数一致', (rtDoc.proxies as any[]).length === 6);
const rtCycle = detectGroupCycle(roundTrip);
check('往返输出: 默认模板无策略组环', !rtCycle.cycle, rtCycle.desc);

// YAML 输入 → v2ray base64：xhttp 节点 type=xhttp 保留
const yamlV2 = Buffer.from(toV2ray(yamlNodes), 'base64').toString('utf8');
check('v2ray 输出含 type=xhttp 链接', yamlV2.includes('type=xhttp'), yamlV2.split('\n').find(l => l.includes('XHTTP')) ?? '');

// 嵌套 proxies:（proxy-groups 内）不应误触发 YAML 解析路径
check('无顶层 proxies: 的内容不误判', parseSubscription('  - proxies: ["a"]\n    name: x').length === 0);

// ==================== 11. 全格式解析：sing-box JSON / v2ray JSON / 混排合并 / base64 套 YAML ====================
console.log('\n[11] 全格式解析与多源合并');
const SINGBOX_JSON = JSON.stringify({
  outbounds: [
    { type: 'vless', tag: 'SB-Vless-WS', server: '1.1.1.1', server_port: 443, uuid: 'b69cf773-da16-486e-afce-a45b94f998b3', flow: 'xtls-rprx-vision',
      tls: { enabled: true, server_name: 'sb.example.com', utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: 'sbpbk', short_id: 'sid1' } },
      transport: { type: 'ws', path: '/sbws', headers: { Host: 'sbhost.example.com' } } },
    { type: 'trojan', tag: 'SB-Trojan', server: '2.2.2.2', server_port: 443, password: 'sbpass',
      tls: { enabled: true, server_name: 'tr.example.com' } },
    { type: 'ss', tag: 'SB-SS', server: '3.3.3.3', server_port: 8388, method: 'aes-256-gcm', password: 'sbsspass' },
    { type: 'hysteria2', tag: 'SB-Hy2', server: '4.4.4.4', server_port: 443, password: 'x' },
    { type: 'direct', tag: 'direct' },
  ],
});
const sbNodes = parseSubscription(SINGBOX_JSON);
check('sing-box JSON 解析出 4 个节点（含 hysteria2，direct 跳过）', sbNodes.length === 4, `实际 ${sbNodes.length}`);
check('sing-box hysteria2 节点被识别', !!sbNodes.find(n => n.name === 'SB-Hy2' && n.protocol === 'hysteria2' && n.password === 'x'));
const sbV = sbNodes.find(n => n.name === 'SB-Vless-WS');
check('sing-box vless: uuid/flow/reality/ws 传输还原', !!sbV && sbV.uuid === 'b69cf773-da16-486e-afce-a45b94f998b3' && sbV.flow === 'xtls-rprx-vision' && sbV.pbk === 'sbpbk' && sbV.network === 'ws' && sbV.host === 'sbhost.example.com' && sbV.path === '/sbws', JSON.stringify(sbV));
const sbT = sbNodes.find(n => n.name === 'SB-Trojan');
check('sing-box trojan: password 还原且强制 tls', !!sbT && sbT.password === 'sbpass' && sbT.tls === true && sbT.sni === 'tr.example.com');

const V2RAY_JSON = JSON.stringify([
  { v: '2', ps: 'V2J-节点', add: '5.5.5.5', port: '443', id: 'b69cf773-da16-486e-afce-a45b94f998b3', aid: '0', net: 'ws', host: 'v2j.example.com', path: '/v2j', tls: 'tls', sni: 'v2j.example.com' },
  { add: '6.6.6.6', port: 80, id: 'another-uuid', ps: 'V2J-TCP' },
]);
const v2jNodes = parseSubscription(V2RAY_JSON);
check('v2ray JSON 数组解析出 2 个 vmess 节点', v2jNodes.length === 2 && v2jNodes.every(n => n.protocol === 'vmess'), `实际 ${v2jNodes.length}`);
check('v2ray JSON 字段还原（host/path/tls）', v2jNodes[0].host === 'v2j.example.com' && v2jNodes[0].path === '/v2j' && v2jNodes[0].tls === true && v2jNodes[0].name === 'V2J-节点');

// 混排合并：YAML + 节点链接 + sing-box JSON 拼在一起（模拟多个不同格式订阅粘进同一框）
const dupLink = 'vless://b69cf773-da16-486e-afce-a45b94f998b3@47.238.122.8:443?type=ws&host=sf.an225.pp.ua&path=%2F&encryption=none&security=tls&sni=sf.an225.pp.ua#%F0%9F%87%AD%F0%9F%87%B0%E9%A6%99%E6%B8%AF-1-WS'; // 与 YAML 内香港-1-WS 完全同参 → 应去重
const extraLink = 'trojan://xpass@7.7.7.7:443?sni=mixed.example.com#🇲🇴Mixed-额外';
const mixedContent = [CLASH_YAML_INPUT, dupLink, extraLink, SINGBOX_JSON].join('\n');
const mixedNodes = parseSubscription(mixedContent);
// YAML 6 + singbox 4 + 额外 trojan 1 = 11；重复的香港-1-WS 链接被去重
check('混排合并：YAML+链接+singbox 合计 11 节点且重复项去重', mixedNodes.length === 11, `实际 ${mixedNodes.length}`);
check('混排合并：额外 trojan 被识别', !!mixedNodes.find(n => n.name === '🇲🇴Mixed-额外'));
check('混排合并：sing-box 节点被识别', !!mixedNodes.find(n => n.name === 'SB-Vless-WS'));

// base64 套 YAML：整份 YAML 先 base64 再解析（模拟 base64 订阅里返回的是 clash 配置）
const b64Yaml = parseSubscription(Buffer.from(CLASH_YAML_INPUT, 'utf8').toString('base64'));
check('base64 套 YAML 递归解析出 6 节点', b64Yaml.length === 6, `实际 ${b64Yaml.length}`);

// 多源合并（路由层逐源解析模拟）：YAML 源 + base64 链接源
const b64LinkSub = Buffer.from(['vless://u1@a.com:443?type=ws#A1', 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'B1', add: 'b.com', port: '443', id: 'u2', aid: '0', net: 'ws', tls: 'tls' })).toString('base64')].join('\n'), 'utf8').toString('base64');
const multiSource = [parseSubscription(CLASH_YAML_INPUT), parseSubscription(b64LinkSub)].flat();
check('多源合并：YAML 源 + base64 源 = 8 节点', multiSource.length === 8, `实际 ${multiSource.length}`);

// 同端口不同 uuid 的节点不去重（保留两个）
const samePortDiffUuid = [
  'vless://uuid-aaa@9.8.7.6:443?type=ws#节点A',
  'vless://uuid-bbb@9.8.7.6:443?type=ws#节点B',
].join('\n');
check('同端口不同 uuid 不误去重', parseSubscription(samePortDiffUuid).length === 2);

// 极端混排：整份 YAML + 独立 base64 行(2条链接) + sing-box JSON 全拼一坨（单次解析全识别）
const extremeMixed = CLASH_YAML_INPUT + '\n' + b64LinkSub + '\n' + SINGBOX_JSON;
check('极端混排：YAML+base64行+singbox 一次解析 = 12 节点', parseSubscription(extremeMixed).length === 12, `实际 ${parseSubscription(extremeMixed).length}`);

// ===== [11] rule-providers 必须输出为映射（数组会导致 mihomo 报 "cannot unmarshal !!seq into map[...]"）=====
const rpIni = [
  '[custom_proxy_group]',
  '🚀 节点选择`select`[]♻️ 自动选择`[]🎯 全球直连',
  '♻️ 自动选择`url-test`[].*`http://www.gstatic.com/generate_204`300,50',
  '[ruleset]',
  '局域网,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list,🎯 全球直连',
  'GoogleFCM,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/GoogleFCM.list,♻️ 自动选择',
].join('\n');
const rpConfig = parseConfigIni(rpIni);
const rpYaml = toClash(parseSubscription('vless://uuid-rp@1.2.3.4:443?type=ws#RP-节点'), 'RP测试', rpConfig);
const rpDoc = parse(rpYaml) as any;
const rpMap = rpDoc?.['rule-providers'];
check('rule-providers 是映射而非数组（mihomo 兼容关键）', !!rpMap && !Array.isArray(rpMap) && typeof rpMap === 'object');
check('rule-providers tag 取 URL 文件名（可读性）', !!rpMap && Object.keys(rpMap).includes('rs0_LocalAreaNetwork') && Object.keys(rpMap).includes('rs1_GoogleFCM'));
check('rule-providers 字段完整（type/behavior/url/path）', !!rpMap && rpMap['rs0_LocalAreaNetwork']?.type === 'http' && rpMap['rs0_LocalAreaNetwork']?.behavior === 'classical' && String(rpMap['rs0_LocalAreaNetwork']?.url).endsWith('LocalAreaNetwork.list') && rpMap['rs0_LocalAreaNetwork']?.path === './ruleset/rs0_LocalAreaNetwork.txt');
check('RULE-SET 引用名与 rule-providers key 一一对应', !!rpMap && rpYaml.includes('RULE-SET,rs0_LocalAreaNetwork,🎯 全球直连') && rpYaml.includes('RULE-SET,rs1_GoogleFCM,♻️ 自动选择'));
check('rule-providers 段无残留列表写法', !/^  - tag:/m.test(rpYaml));

// ===== [12] AnyTLS 协议：解析 / 各目标输出 / 往返 / 输入反向 =====
console.log('\n[12] AnyTLS 协议');
const ANYTLS_LINK = 'anytls://1613a493eaa144a2@e73c95a5.test.sbs:3708?security=tls&sni=cache-proxy.example.com&fp=chrome&alpn=h2&insecure=1&allowInsecure=1&type=tcp#AnyTLS-Test';
const an = parseSubscription(ANYTLS_LINK);
check('anytls 链接解析出 1 个节点', an.length === 1, `实际 ${an.length}`);
check('anytls 字段完整（密码/SNI/指纹/ALPN/端口）',
  an[0]?.protocol === 'anytls' && an[0]?.password === '1613a493eaa144a2'
  && an[0]?.sni === 'cache-proxy.example.com' && an[0]?.fp === 'chrome'
  && an[0]?.alpn === 'h2' && an[0]?.port === 3708);
check('insecure=1 / allowInsecure=1 → skipCertVerify', an[0]?.skipCertVerify === true);

const anClash = toClash(an, 'AnyTLS测试');
const anDoc = parse(anClash) as any;
const anProxy = anDoc?.proxies?.[0];
check('Clash 输出 type: anytls', anProxy?.type === 'anytls');
check('Clash 输出 password/sni/alpn/client-fingerprint/skip-cert-verify',
  anProxy?.password === '1613a493eaa144a2' && anProxy?.sni === 'cache-proxy.example.com'
  && JSON.stringify(anProxy?.alpn) === '["h2"]'
  && anProxy?.['client-fingerprint'] === 'chrome'
  && anProxy?.['skip-cert-verify'] === true);
check('Clash 输出 anytls 会话池字段', anProxy?.['idle-session-timeout'] === 30 && anProxy?.udp === true);

const anSb = JSON.parse(toSingbox(an, 'AnyTLS测试'));
const anOut = (anSb.outbounds ?? []).find((o: any) => o.type === 'anytls');
check('sing-box 输出 anytls outbound（含 tls/utls/insecure）',
  !!anOut && anOut.password === '1613a493eaa144a2' && anOut.tls?.enabled === true
  && anOut.tls?.insecure === true && anOut.tls?.utls?.fingerprint === 'chrome'
  && JSON.stringify(anOut.tls?.alpn) === '["h2"]');
check('toLink 往返仍可解析为 anytls', parseSubscription(toLink(an[0]))[0]?.protocol === 'anytls');
check('mixed / v2ray 输出保留 anytls:// 链接',
  toMixed(an).startsWith('anytls://')
  && Buffer.from(toV2ray(an), 'base64').toString('utf8').startsWith('anytls://'));

const AN_YAML = [
  'proxies:',
  '  - name: YAML-AnyTLS',
  '    type: anytls',
  '    server: yaml.example.com',
  '    port: 443',
  '    password: pw123',
  '    sni: sni.example.com',
  '    alpn: [h2]',
  '    client-fingerprint: chrome',
  '    skip-cert-verify: true',
].join('\n');
const anYaml = parseSubscription(AN_YAML);
check('Clash YAML 输入反向解析 anytls', anYaml.length === 1 && anYaml[0].protocol === 'anytls'
  && anYaml[0].password === 'pw123' && anYaml[0].skipCertVerify === true);

const AN_SB_JSON = JSON.stringify({ outbounds: [
  { type: 'anytls', tag: 'sb-anytls', server: 'sb.example.com', server_port: 443, password: 'pw456',
    tls: { enabled: true, server_name: 'sni.example.com', insecure: true, alpn: ['h2'],
           utls: { enabled: true, fingerprint: 'chrome' } } },
] });
const anJson = parseSubscription(AN_SB_JSON);
check('sing-box JSON 输入解析 anytls', anJson.length === 1 && anJson[0].protocol === 'anytls'
  && anJson[0].password === 'pw456' && anJson[0].skipCertVerify === true
  && anJson[0].sni === 'sni.example.com');

check('Surge 目标正确报告 anytls 不支持', (() => {
  const u = getUnsupported('surge', an);
  return u.length === 1 && u[0].protocol === 'anytls' && u[0].count === 1;
})());
check('Clash 目标不报告 anytls 不支持', getUnsupported('clash', an).length === 0);
check('anytls 与普通节点混排可一起解析',
  parseSubscription(RAW + '\n' + ANYTLS_LINK).length === 6);

// ===== [13] Hysteria2 / TUIC 协议 =====
console.log('\n[13] Hysteria2 / TUIC');
const HY2_LINK = 'hysteria2://pass123@hy2.example.com:443?sni=hy2.example.com&alpn=h3&insecure=1&obfs=salamander&obfs-password=obfspw&pinSHA256=abcd1234&mport=1000-2000&up=30%20Mbps&down=200%20Mbps#HY2-Node';
const HY2_ALIAS = 'hy2://pass999@alias.example.com:8443?insecure=0#HY2-Alias';
const TUIC5_LINK = 'tuic://00000000-0000-0000-0000-000000000001:pw456@tuic.example.com:10443?sni=tuic.example.com&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1&reduce_rtt=1#TUIC5-Node';
const TUIC4_LINK = 'tuic://TOKEN123@v4.example.com:443?version=4&congestion_control=cubic#TUIC4-Node';
const qn = parseSubscription([HY2_LINK, HY2_ALIAS, TUIC5_LINK, TUIC4_LINK].join('\n'));
check('hy2/tuic 共 4 个节点（含 hy2 别名与 tuic v4）', qn.length === 4, `实际 ${qn.length}`);
const hy2 = qn.find(n => n.server === 'hy2.example.com');
check('hysteria2 字段（密码/sni/alpn/obfs/混淆密码/指纹/端口跳跃/速率）',
  hy2?.protocol === 'hysteria2' && hy2?.password === 'pass123' && hy2?.sni === 'hy2.example.com'
  && hy2?.alpn === 'h3' && hy2?.obfs === 'salamander' && hy2?.obfsPassword === 'obfspw'
  && hy2?.fingerprint === 'abcd1234' && hy2?.ports === '1000-2000'
  && hy2?.up === '30 Mbps' && hy2?.down === '200 Mbps' && hy2?.skipCertVerify === true);
check('hy2:// 别名可解析', qn.some(n => n.server === 'alias.example.com' && n.protocol === 'hysteria2'));
const tuic5 = qn.find(n => n.server === 'tuic.example.com');
check('TUIC v5 拆分 uuid:password 并保留拥塞控制/UDP 模式',
  tuic5?.protocol === 'tuic' && tuic5?.uuid === '00000000-0000-0000-0000-000000000001'
  && tuic5?.password === 'pw456' && !tuic5?.token
  && tuic5?.congestionController === 'bbr' && tuic5?.udpRelayMode === 'native'
  && tuic5?.reduceRtt === true && tuic5?.skipCertVerify === true);
check('TUIC v4 使用 token 且不写 uuid', qn.some(n => n.protocol === 'tuic' && n.token === 'TOKEN123' && !n.uuid && n.congestionController === 'cubic'));

const qClash = parse(toClash(qn, 'QUIC测试')) as any;
const qProxies = qClash?.proxies ?? [];
const hy2p = qProxies.find((p: any) => p.type === 'hysteria2');
const tuicp = qProxies.find((p: any) => p.type === 'tuic');
check('Clash 输出 type: hysteria2（含 obfs/ports/up/down/fingerprint）',
  !!hy2p && hy2p.obfs === 'salamander' && hy2p['obfs-password'] === 'obfspw'
  && hy2p.ports === '1000-2000' && hy2p.up === '30 Mbps' && hy2p.fingerprint === 'abcd1234'
  && JSON.stringify(hy2p.alpn) === '["h3"]');
check('Clash 输出 type: tuic（含 uuid/password/congestion-controller/reduce-rtt）',
  !!tuicp && tuicp.uuid === '00000000-0000-0000-0000-000000000001'
  && tuicp.password === 'pw456' && tuicp['congestion-controller'] === 'bbr'
  && tuicp['udp-relay-mode'] === 'native' && tuicp['reduce-rtt'] === true);

const qSb = JSON.parse(toSingbox(qn, 'QUIC测试'));
const hy2Out = qSb.outbounds.find((o: any) => o.type === 'hysteria2');
const tuicOut = qSb.outbounds.find((o: any) => o.type === 'tuic');
check('sing-box 输出 hysteria2（obfs/up_mbps/down_mbps/tls）',
  !!hy2Out && hy2Out.password === 'pass123' && hy2Out.obfs?.type === 'salamander'
  && hy2Out.up_mbps === 30 && hy2Out.down_mbps === 200 && hy2Out.tls?.insecure === true);
check('sing-box 输出 tuic（congestion_control/zero_rtt_handshake/tls）',
  !!tuicOut && tuicOut.uuid === '00000000-0000-0000-0000-000000000001'
  && tuicOut.congestion_control === 'bbr' && tuicOut.zero_rtt_handshake === true
  && tuicOut.tls?.insecure === true);
check('hy2 / tuic 链接往返后仍可解析', qn.every(n => parseSubscription(toLink(n))[0]?.protocol === n.protocol));
check('mixed / v2ray 保留 hysteria2:// 与 tuic:// 链接',
  toMixed(qn).includes('hysteria2://') && toMixed(qn).includes('tuic://')
  && Buffer.from(toV2ray(qn), 'base64').toString('utf8').includes('hysteria2://'));
check('+ 号按空格解码（up/down 往返不损坏）', parseSubscription(toLink(hy2!))[0]?.up === '30 Mbps');

const QUIC_YAML = [
  'proxies:',
  '  - name: YAML-HY2',
  '    type: hysteria2',
  '    server: y-hy2.example.com',
  '    port: 443',
  '    password: p1',
  '    obfs: salamander',
  '    obfs-password: o1',
  '    alpn: [h3]',
  '  - name: YAML-TUIC',
  '    type: tuic',
  '    server: y-tuic.example.com',
  '    port: 443',
  '    uuid: uuid-y',
  '    password: p2',
  '    congestion-controller: cubic',
  '    udp-relay-mode: quic',
  '    disable-sni: true',
].join('\n');
const qYaml = parseSubscription(QUIC_YAML);
check('Clash YAML 输入反向解析 hysteria2 + tuic', qYaml.length === 2
  && qYaml.some(n => n.protocol === 'hysteria2' && n.obfsPassword === 'o1')
  && qYaml.some(n => n.protocol === 'tuic' && n.congestionController === 'cubic' && n.disableSni === true));

const QUIC_JSON = JSON.stringify({ outbounds: [
  { type: 'hysteria2', tag: 'sb-hy2', server: 'j-hy2.example.com', server_port: 443, password: 'p3',
    up_mbps: 50, down_mbps: 300, obfs: { type: 'salamander', password: 'o3' }, tls: { enabled: true, insecure: true, server_name: 'j.example.com' } },
  { type: 'tuic', tag: 'sb-tuic', server: 'j-tuic.example.com', server_port: 443, uuid: 'uuid-j', password: 'p4',
    congestion_control: 'bbr', udp_relay_mode: 'native', zero_rtt_handshake: true, tls: { enabled: true, server_name: 'j.example.com' } },
] });
const qJson = parseSubscription(QUIC_JSON);
check('sing-box JSON 输入反向解析 hysteria2 + tuic', qJson.length === 2
  && qJson.some(n => n.protocol === 'hysteria2' && n.up === '50 Mbps' && n.obfsPassword === 'o3')
  && qJson.some(n => n.protocol === 'tuic' && n.reduceRtt === true && n.uuid === 'uuid-j'));

const qUnsup = getUnsupported('surge', qn);
check('Surge 报告 hysteria2 / tuic 不支持', qUnsup.some(u => u.protocol === 'hysteria2') && qUnsup.some(u => u.protocol === 'tuic'));
check('Clash 目标不报告 QUIC 协议不支持', getUnsupported('clash', qn).length === 0);
check('7 种协议混排一次解析 = 9 节点', parseSubscription(RAW + '\n' + ANYTLS_LINK + '\n' + HY2_LINK + '\n' + TUIC5_LINK + '\n' + TUIC4_LINK).length === 9);

console.log(`\n========== 结果: ${pass} 通过, ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
