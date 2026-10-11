# SubConv 订阅转换工具 - 完整文档

> 支持 8 种客户端格式互转（Clash/Clash.Meta/sing-box/Surge/QuantumultX/Loon/V2Ray/Mixed），含节点测速、去重、重命名、配置规则、分享二维码。

## 目录

- [快速部署](#快速部署)
- [短链接功能（KV 存储）配置](#短链接功能kv-存储配置)
- [API 文档](#api-文档)
  - [1. 订阅转换 GET /api/sub](#1-订阅转换-get--apisub)
  - [2. 订阅转换 POST /api/sub](#2-订阅转换-post--apisub)
  - [3. 节点测速 POST /api/speedtest](#3-节点测速-post--apispeedtest)
  - [4. 短链接生成 POST /api/shorten](#4-短链接生成-post--apishorten)
- [使用示例](#使用示例)
- [自定义域名](#自定义域名)
- [常见问题](#常见问题)

---

## 快速部署

### 方式一：CLI 部署（推荐首次）

```bash
# 1. 解压
unzip subconv.zip -d subconv && cd subconv

# 2. 安装依赖
bun install   # 或 npm install

# 3. 登录 Cloudflare（浏览器弹出授权页）
npx wrangler login

# 4. 一键部署
./deploy.sh
```

部署后访问：`https://subconv.pages.dev`

### 方式二：GitHub 自动部署（推荐长期）

```bash
# 1. 推送到 GitHub
cd subconv
git init && git add . && git commit -m "SubConv"
git remote add origin https://github.com/你的用户名/subconv.git
git push -u origin main
```

```
# 2. Cloudflare Dashboard 配置
Dashboard → Pages → Create a project → Connect to Git
  Framework preset:    Next.js
  Build command:        bun run pages:build
  Build output dir:     .vercel/output/static
  Environment vars:     NODE_VERSION=20
```

之后每次 `git push` 自动部署。

### 方式三：本地预览

```bash
bun install
bun run pages:preview    # 访问 http://localhost:8788
```

---

## 短链接功能（KV 存储）配置

**为什么需要短链接**：SubConv 是无状态服务（不存任何数据），直接粘贴节点生成订阅时，节点内容只能全部编码进 URL（`raw=` 参数），链接又长又难扫二维码。短链接模式把节点参数存入 Cloudflare KV，换取形如 `https://你的域名/api/sub?id=Ab3dEf9H` 的短链接。

**启用步骤**（约 2 分钟）：

```bash
# 1. 创建 KV 命名空间（需先 npx wrangler login）
npx wrangler kv namespace create SUBS_KV
# 输出示例:
# 🌀 Creating namespace with title "subconv-SUBS_KV"
# ✨ Success! Add the following to your configuration file in your kv_namespaces block:
# [[kv_namespaces]]
# binding = "SUBS_KV"
# id = "e29b26xxxxxxxxxxxxxxxxxxxxxxxxxx"

# 2. 把上面的 id 回填到 wrangler.toml 的 [[kv_namespaces]] 段并去掉注释

# 3. 重新部署
bun run pages:deploy
```

GitHub 自动部署的用户：回填 wrangler.toml 后 push 即可生效。

**行为说明**：

- 未配置 KV 时，站点其他功能完全正常，仅短链接相关接口返回 501 提示；前端开启「短链接」开关后会自动回退完整链接并 toast 提醒。
- 短链接默认 **90 天**有效（KV TTL 到期自动删除，可在请求 `ttlDays` 参数 1~365 天调整）。
- 短链接 ID 为 8 位无歧义 base62（约 46 bit 随机熵），无法枚举；但链接本身包含节点凭据，请勿公开分享。
- KV 免费额度：每天 1000 次写入 / 10 万次读取，个人使用绰绰有余；写入发生在「生成短链」时，读取发生在客户端每次刷新订阅时。

---

## API 文档

### 1. 订阅转换 GET /api/sub

生成订阅链接，客户端直接导入此链接即可（最常用）。

**请求**

```
GET /api/sub?target=<格式>&url=<订阅链接>&name=<名称>&config=<远程配置URL>&configRaw=<自定义配置>
```

**参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `target` | ✅ | 目标格式：`clash` / `clashmeta` / `singbox` / `surge` / `quantumultx` / `loon` / `v2ray` / `mixed` |
| `id` | ⚠️* | 短链接 ID（由 POST /api/shorten 生成）。*短链模式下无需其他参数 |
| `url` | ⚠️* | 订阅链接（http/https），多个用 `\|` 分隔。*与 `raw`/`id` 三选一 |
| `raw` | ⚠️* | 直接传节点链接内容（vless/vmess/trojan/ss，每行一个）。*与 `url`/`id` 三选一 |
| `name` | ❌ | 订阅名称，默认「订阅转换」 |
| `config` | ❌ | 远程配置规则 URL（subconverter ini 格式），仅 `clash`/`clashmeta` 生效 |
| `configRaw` | ❌ | 自定义配置规则内容（ini 格式），仅 `clash`/`clashmeta` 生效 |
| `dedup` | ❌ | 传 `1` 开启节点去重（按 server:port） |
| `renameMode` | ❌ | 节点重命名模式（配合 `renamePrefix`） |
| `renamePrefix` | ❌ | 重命名前缀 |

> 短链接 `id` 模式下，生成时保存的全部参数（含 target/name/config/去重/重命名）自动还原应用，无需重复传递。

**响应**：对应格式的配置文件

| target | Content-Type | 扩展名 |
|--------|--------------|--------|
| clash / clashmeta | text/yaml | .yaml |
| singbox | application/json | .json |
| surge / quantumultx / loon | text/plain | .conf |
| v2ray / mixed | text/plain | .txt |

**示例**

```bash
# 基础：订阅链接转 Clash
curl "https://subconv.pages.dev/api/sub?target=clash&url=https://example.com/sub"

# 多订阅合并
curl "https://subconv.pages.dev/api/sub?target=clash&url=https://a.com/sub|https://b.com/sub"

# 直接传节点内容转 sing-box
curl "https://subconv.pages.dev/api/sub?target=singbox&raw=vless://uuid@1.2.3.4:443#节点1"

# 使用远程配置规则（ACL4SSR）
curl "https://subconv.pages.dev/api/sub?target=clash&url=https://example.com/sub&config=https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini"

# 转 Surge
curl "https://subconv.pages.dev/api/sub?target=surge&url=https://example.com/sub&name=我的订阅"
```

**客户端导入**：直接把完整 URL 填入客户端的「订阅链接」栏即可。

#### 调用示例汇总

```bash
# ① 单订阅转 Clash（最常用）
curl "https://subconv.pages.dev/api/sub?target=clash&url=https://你的订阅链接"

# ② 单订阅转 sing-box
curl "https://subconv.pages.dev/api/sub?target=singbox&url=https://你的订阅链接"

# ③ 单订阅转 Surge（带名称）
curl "https://subconv.pages.dev/api/sub?target=surge&url=https://你的订阅链接&name=我的订阅"

# ④ 单订阅转 V2Ray base64
curl "https://subconv.pages.dev/api/sub?target=v2ray&url=https://你的订阅链接"

# ⑤ 多订阅合并（用 | 分隔）
curl "https://subconv.pages.dev/api/sub?target=clash&url=https://机场A订阅|https://机场B订阅"

# ⑥ 使用 ACL4SSR 配置规则
curl "https://subconv.pages.dev/api/sub?target=clash&url=https://你的订阅&config=https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini"

# ⑦ 保存到文件
curl -o config.yaml "https://subconv.pages.dev/api/sub?target=clash&url=https://你的订阅链接"
```

> ⚠️ URL 含特殊字符（如订阅链接里的 `&`、`=`）时，浏览器和客户端会自动编码。手动 curl 测试若失败，把 `|` 编码为 `%7C`，`&` 编码为 `%26`。

#### 客户端导入示例

在客户端的「订阅链接」栏粘贴以下完整 URL：

| 客户端 | 订阅链接 |
|--------|----------|
| Clash Verge / Clash for Windows / Mihomo | `https://你的域名/api/sub?target=clash&url=你的订阅&name=我的订阅` |
| sing-box / SFA / SFI | `https://你的域名/api/sub?target=singbox&url=你的订阅` |
| Surge（iOS/macOS）| `https://你的域名/api/sub?target=surge&url=你的订阅&name=Surge` |
| Quantumult X（iOS）| `https://你的域名/api/sub?target=quantumultx&url=你的订阅` |
| Loon（iOS）| `https://你的域名/api/sub?target=loon&url=你的订阅` |
| V2RayN / V2RayNG / Shadowrocket | `https://你的域名/api/sub?target=v2ray&url=你的订阅` |

#### target 参数对照表

| target 值 | 客户端 | 格式 | vless 支持 |
|-----------|--------|------|-----------|
| `clash` | Clash / Mihomo / Clash Verge | YAML | ✅ |
| `clashmeta` | Clash.Meta 内核 | YAML | ✅ |
| `singbox` | sing-box / SFA / SFI | JSON | ✅ |
| `surge` | Surge | conf | ❌ 自动跳过 |
| `quantumultx` | Quantumult X | conf | ❌ 自动跳过 |
| `loon` | Loon | conf | ❌ 自动跳过 |
| `v2ray` | V2RayN / V2RayNG | base64 | ✅ |
| `mixed` | 通用（原始链接）| txt | ✅ |

---

### 2. 订阅转换 POST /api/sub

预览转换结果（含节点列表统计），用于前端展示或程序化调用。

**请求**

```http
POST /api/sub
Content-Type: application/json
```

**Body**

```jsonc
{
  "target": "clash",              // 必填，目标格式
  "url": "https://...",           // 订阅链接（与 raw 二选一）
  "raw": "vless://...",           // 节点内容（与 url 二选一）
  "name": "订阅转换",             // 可选，订阅名称
  "configUrl": "https://...",     // 可选，远程配置 URL（仅 clash/clashmeta）
  "configRaw": "[custom_proxy_group]...",  // 可选，自定义配置内容（仅 clash/clashmeta）
  "dedup": true,                  // 可选，去重（按 protocol+server+port）
  "renamePrefix": "HK",           // 可选，重命名前缀
  "renameMode": "prefix-seq"      // 可选，重命名模式：prefix-seq/keep-seq/prefix-only
}
```

**响应**

```jsonc
{
  "success": true,
  "target": "clash",
  "count": 12,                    // 转换后节点数
  "nodes": [                      // 节点列表
    { "name": "节点A", "protocol": "vless", "server": "1.2.3.4", "port": 443, "link": "vless://..." }
  ],
  "configInfo": {                 // 配置规则统计
    "groups": 10,
    "rulesets": 0,
    "customRules": 121
  },
  "dedupRemoved": 2,              // 去重移除数（dedup=true 时有）
  "unsupported": [                // 不支持的协议（Surge/Loon/QX 的 vless）
    { "protocol": "vless", "count": 1 }
  ],
  "result": "# Clash 配置..."     // 转换后的完整配置文本
}
```

**示例**

```bash
# 预览转换 + 去重 + 重命名
curl -X POST https://subconv.pages.dev/api/sub \
  -H "Content-Type: application/json" \
  -d '{
    "target": "clash",
    "raw": "vless://uuid@1.1.1.1:443#节点A\nss://...@2.2.2.2:8388#节点B",
    "dedup": true,
    "renameMode": "prefix-seq",
    "renamePrefix": "HK"
  }'
```

---

### 3. 节点测速 POST /api/speedtest

测试节点 TCP 建连可达性（非真实代理延迟，仅作参考）。

**请求**

```http
POST /api/speedtest
Content-Type: application/json
```

**Body**

```jsonc
{
  "url": "https://...",     // 订阅链接（与 raw 二选一）
  "raw": "vless://...",     // 节点内容（与 url 二选一）
  "timeout": 5000,          // 可选，单节点超时 ms，默认 5000
  "concurrency": 8          // 可选，并发数 1-20，默认 8
}
```

**响应**

```jsonc
{
  "success": true,
  "total": 10,              // 总节点数
  "ok": 7,                  // 可达数
  "fail": 3,                // 失败数
  "avgDelay": 156,          // 平均延迟 ms（仅可达节点）
  "results": [              // 按延迟升序排列
    { "name": "节点A", "server": "1.1.1.1", "port": 443, "protocol": "vless", "ok": true, "delay": 45 },
    { "name": "节点B", "ok": false, "delay": null, "err": "超时 (5000ms)" }
  ]
}
```

**示例**

```bash
curl -X POST https://subconv.pages.dev/api/speedtest \
  -H "Content-Type: application/json" \
  -d '{"raw":"vless://uuid@1.1.1.1:443#CF\nss://...@8.8.8.8:443#Google","timeout":3000}'
```

---

### 4. 短链接生成 POST /api/shorten

把转换参数存入 KV，返回短链接 `https://域名/api/sub?id=xxxxxxxx`。需要先配置 KV 绑定 `SUBS_KV`（见上文配置章节），未配置返回 501。

**请求**

```http
POST /api/shorten
Content-Type: application/json
```

**Body**

```jsonc
{
  "raw": "vless://...",     // 节点内容（与 url 二选一，同 /api/sub）
  "url": "https://...",     // 订阅链接（与 raw 二选一）
  "target": "clash",        // 必填，同 /api/sub
  "name": "订阅转换",        // 可选
  "configUrl": "...",       // 可选，远程配置规则
  "configRaw": "...",       // 可选，自定义配置规则
  "dedup": true,            // 可选，去重
  "renamePrefix": "HK",     // 可选，重命名前缀
  "renameMode": "prefix-seq", // 可选
  "ttlDays": 90             // 可选，有效期 1~365 天，默认 90
}
```

**响应**

```jsonc
{
  "success": true,
  "id": "Ab3dEf9H",
  "shortUrl": "https://subconv.pages.dev/api/sub?id=Ab3dEf9H",
  "ttlDays": 90,
  "nodes": 4
}
```

**说明**：存储前会先解析校验节点，无效内容不会写入 KV；`raw` 上限 1MB；ID 撞键自动重试。

**示例**

```bash
curl -X POST https://subconv.pages.dev/api/shorten \
  -H "Content-Type: application/json" \
  -d '{"target":"clash","raw":"vless://uuid@1.2.3.4:443?type=ws#香港-1","ttlDays":180}'
# 之后客户端导入 https://subconv.pages.dev/api/sub?id=Ab3dEf9H
```

---

## 使用示例

### 客户端导入订阅

部署后，在 Clash/sing-box 等客户端添加订阅，URL 填：

```
https://你的域名/api/sub?target=clash&url=你的机场订阅链接&name=我的订阅
```

### 程序化调用（Python）

```python
import requests

# 转换订阅
r = requests.get("https://subconv.pages.dev/api/sub", params={
    "target": "clash",
    "url": "https://example.com/sub",
    "name": "我的订阅"
})
open("config.yaml", "w").write(r.text)

# 测速
r = requests.post("https://subconv.pages.dev/api/speedtest", json={
    "url": "https://example.com/sub",
    "timeout": 3000,
    "concurrency": 10
})
data = r.json()
print(f"可达 {data['ok']}/{data['total']}，均速 {data['avgDelay']}ms")
for n in data["results"][:5]:
    print(f"  {n['name']}: {n['delay']}ms" if n["ok"] else f"  {n['name']}: 超时")
```

### 配置规则格式（subconverter ini）

`configRaw` 或远程 `config` URL 的内容格式：

```ini
[custom_proxy_group]
🚀 节点选择`select`[]♻️ 自动选择`[].*`[]🎯 全球直连
♻️ 自动选择`url-test`[].*`http://www.gstatic.com/generate_204`300,50
🎯 全球直连`select`[]DIRECT`[]🚀 节点选择

[ruleset]
GitHub,https://raw.githubusercontent.com/.../github.ini,🚀 节点选择

[custom_rule]
DOMAIN-SUFFIX,google.com,🚀 节点选择
GEOIP,CN,🎯 全球直连
MATCH,🐟 漏网之鱼
```

**语法说明**
- `[custom_proxy_group]`：策略组定义，格式 `名称`type`选项1`选项2`...`
  - `[]组名` = 引用其他组
  - `[].*` = 正则匹配节点
  - `http://...` = url-test 健康检查地址
  - `300,50` = interval,tolerance
- `[ruleset]`：远程规则集，格式 `标签,URL,目标组`
- `[custom_rule]`：自定义规则行（Clash 规则语法）

---

## 自定义域名

部署后绑定自己的域名：

1. Cloudflare Dashboard → Pages → subconv 项目 → Custom domains
2. 点击 Set up a custom domain
3. 输入你的域名（如 `subconv.yourdomain.com`）
4. 按提示添加 CNAME 记录指向 `subconv.pages.dev`
5. 等待证书生效（约 1-5 分钟）

绑定后订阅链接变为：
```
https://subconv.yourdomain.com/api/sub?target=clash&url=...
```

---

## 常见问题

### Q: 部署后访问报 500？

A: 检查 Cloudflare Dashboard → Pages → 项目 → Functions → 实时日志，常见原因：
- API route 未声明 `runtime = 'edge'`（本项目已全部声明）
- 依赖未正确安装（确保 `bun install` 成功）

### Q: 订阅链接在客户端报错？

A: 检查：
1. 浏览器直接访问订阅链接，看是否返回配置文本
2. 确认 `target` 参数正确（clash/singbox 等）
3. 原始订阅链接需为 http/https，节点链接（vless://）请用前端「节点内容」tab

### Q: 测速全部超时？

A: 测速基于 Cloudflare 边缘节点 TCP 建连，国内节点可能延迟较高。测速结果仅作可达性参考，不代表实际代理速度。

### Q: Surge/Loon 不支持 vless？

A: 这是客户端限制，Surge/Loon/QuantumultX 原生不支持 vless 协议。转换时会自动跳过 vless 节点并返回 `unsupported` 提示。建议 vless 节点用 Clash/sing-box/V2Ray 格式。

### Q: 配置规则只对 Clash 生效？

A: 是。`config`/`configRaw` 参数仅 Clash/Clash.Meta 格式支持（因其 YAML 结构灵活）。Surge/Loon/QuantumultX 使用内置精简规则。如需自定义，建议转 Clash 格式。

### Q: 如何更新部署？

A: 
- CLI：修改代码后重新 `./deploy.sh`
- GitHub：`git push` 自动触发重新部署

---

## 技术栈

- **框架**：Next.js 16（App Router + Edge Runtime）
- **语言**：TypeScript
- **样式**：Tailwind CSS 4 + shadcn/ui（teal/emerald 暗色主题）
- **部署**：Cloudflare Pages（@cloudflare/next-on-pages）

## 功能清单

- ✅ 8 种客户端格式转换（Clash/Clash.Meta/sing-box/Surge/QuantumultX/Loon/V2Ray/Mixed）
- ✅ 4 种协议解析（vless/vmess/trojan/ss）
- ✅ 配置规则三模式（默认 100+ 条 / 自定义 ini / 远程 URL）
- ✅ 远程规则集预设库（ACL4SSR 等 5 个一键填入）
- ✅ 配置导入导出（.ini 文件）
- ✅ 节点去重（按 protocol+server+port）
- ✅ 节点重命名（前缀+序号 / 原名+序号 / 前缀+原名）
- ✅ 节点测速（TCP 可达性，并发控制）
- ✅ unsupported 协议检测提示
- ✅ 节点分享二维码（单节点独立分享）
- ✅ 订阅链接二维码（整订阅扫码导入）
- ✅ 智能识别节点链接误填订阅栏
