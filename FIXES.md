# SubConv 修复与新功能报告

> 修复日期：2026-10-11 ｜ 基于 main 分支（1335221）

## 一、修复的问题（共 9 项）

### 1. [P0] 策略组循环引用 —— 客户端报 "loop is detected in ProxyGroup"（本次反馈的问题）

- **位置**：`src/lib/sub-converter.ts` 的 `DEFAULT_CONFIG`，以及 `toSurge` / `toLoon` 模板
- **原因**：`🚀 节点选择` 组包含 `🎯 全球直连`，而 `🎯 全球直连` 又回引 `🚀 节点选择`，形成 A→B→A 环。mihomo（Clash Meta 内核）启动时做依赖图检测，发现环直接拒绝加载，报错并点名的正是这两个组
- **修复**：
  1. 默认模板/Surge/Loon 模板中 `🎯 全球直连` 仅保留 `DIRECT`（与原版 subconverter ACL4SSR 模板一致）；
  2. `expandGroups()` 新增 `breakGroupCycles()` —— 对**任意自定义/远程 ini 配置**自动做环检测（DFS 找回边并删除），用户配置造环也不会再触发该报错；
  3. 环剥离后为空的组自动回填全部节点。
- **验证**：测试含专门的人为环剥离用例，输出 YAML 经解析确认无环。

### 2. [P0] Surge 模板引用未定义策略组

- `[Rule]` 里引用了 `📲 电报信息`、`🌍 国外媒体`，但 `[Proxy Group]` 段根本没有这两个组 → Surge 加载配置报错。
- **修复**：补齐两个组定义（`select, 🚀 节点选择, DIRECT`）。

### 3. [P0] 部署阻断：Next.js 16 Turbopack 无法解析 tw-animate-css

- `globals.css` 的 `@import "tw-animate-css"`：该包仅在 exports 中声明 `style` 条件，Next 16 默认的 Turbopack 构建器无法解析 → `next build` / `pages:build` 直接失败（**当前代码在 Cloudflare Pages 重新构建也会挂**）。
- **修复**：将 `tw-animate-css@1.4.0` 的产物内联为 `src/styles/tw-animate.css`，`globals.css` 改用相对路径引入（文件头有注释说明来源与升级注意事项）。构建已实测通过。

### 4. [P1] 远程/自定义 ini 规则解析不兼容标准 subconverter 格式

- 原解析器只认 `[custom_proxy_group]` / `[ruleset]` / `[custom_rule]` 独立段；而真实世界的 ACL4SSR、ConnersHua 等预设全部是 `[custom]` 段 + `custom_proxy_group=name\`type\`...` / `ruleset=组,url` 前缀行 → 解析结果为空，**策略组和规则全部丢失**（「远程规则 URL」功能形同虚设）。
- **修复**：`parseConfigIni()` 双格式兼容（前缀行任意位置均可识别，段式格式保留），预设 ACL4SSR 链接实测可正常展开。

### 5. [P1] RULE-SET 生成逻辑错误

- 原代码所有规则集的目标组**恒为** `🚀 节点选择`（ini 中指定的组名被无视，还有一段永远为 false 的死逻辑）；且 rule-provider 的 tag 由中文组名 sanitize 生成（全部变成下划线），多个规则集 tag 相互冲突 → mihomo 报 duplicate/找不到 provider。
- **修复**：tag 加索引前缀保证唯一（`rs0_xxx`、`rs1_xxx`…）；目标组优先级 = ini 显式第三段 target > 与策略组名一致的 tag > 回退 `🚀 节点选择`。

### 6. [P1] vmess 节点静默丢失

- `toLink()` 不支持 vmess → **V2Ray / Mixed 目标输出直接丢掉所有 vmess 节点**；前端节点列表的 vmess 分享链接为空。
- **修复**：`toLink()` 支持 vmess（v2rayN 标准 base64 JSON，port/aid 输出为字符串），并经 base64 反解 round-trip 验证字段完整。

### 7. [P2] vless/vmess/trojan 的 fp 指纹参数被丢弃

- **修复**：Clash 输出 `client-fingerprint`；sing-box 在 TLS 节点输出 `tls.utls.fingerprint`。Reality 节点没有 fp 可能无法正确伪装，普通 TLS 节点带上也更贴近原始链接语义。

### 8. [P2] 节点名 YAML 双重转义 + 类型注入

- `yamlStr()` 在 `toClash()` 与 `yamlListItem/yamlObj` 被应用两次，含特殊字符的节点名输出形如 `name: "\"a:b\""`（把引号转进了名字本身，与组引用的名字对不上 → mihomo 报 proxy not found）；纯数字名（如 `443`）会被 YAML 解析成整数。
- **修复**：转义统一收口到输出层做一次；并增加纯数字/布尔字面量（true/false/null/yes/no…）/特殊首字符（`-`、`?`、`[` 等）的强制引号保护。

### 9. [P2] 杂项

- `bilibili.com` 被误路由到「🌍 国外媒体」（国内服务应直连），并补充 `bilivideo.com`；
- `expandGroups()` 对"既不是组、也匹配不到节点"的 opts 原样输出为裸引用 → mihomo "proxy not found"，改为丢弃；
- `next.config.ts` 的 `eslint` 配置键在 Next 16 已移除，删除该键；
- 前端二维码生成失败会中断整个生成流程 → 改为独立容错，二维码区域给出"请开启短链接"提示；
- sing-box 仅在 TLS 节点输出 `tls` 对象，非 TLS 节点不再输出 `tls:{enabled:false}` 冗余字段。

## 二、新功能：KV 短链接

### 使用效果

前端「节点处理」区新增 **「短链接（KV 存储）」** 开关。开启后生成的订阅链接从 800+ 字符变成：

```
https://你的域名/api/sub?id=Ab3dEf9H
```

链接短、二维码易扫、客户端导入体验好。未配置 KV 时自动回退完整链接并 toast 提示，**不影响其他功能**。

### 启用步骤（约 2 分钟）

```bash
# 1. 创建 KV 命名空间（先 npx wrangler login）
npx wrangler kv namespace create SUBS_KV

# 2. 把返回的 id 回填到 wrangler.toml 的 [[kv_namespaces]] 段（模板已备好，取消注释填 id 即可）

# 3. 重新部署
bun run pages:deploy
```

### 设计说明

| 项目 | 说明 |
|------|------|
| 存储 | Cloudflare KV，绑定名固定 `SUBS_KV`；key=`sub:{id}`，value=完整转换参数 JSON |
| ID | `crypto.getRandomValues` 生成 8 位无歧义 base62（去除 0/O/1/l/I），约 46 bit 熵，不可枚举；写入前查重，撞键自动重试 |
| 有效期 | KV TTL 默认 90 天，请求 `ttlDays` 可调 1~365 天，到期自动删除 |
| 还原 | `GET /api/sub?id=xxx` 从 KV 还原全部参数（target/name/config/去重/重命名），与手动传参走同一套转换代码，行为完全一致 |
| 防护 | 存入前先解析校验节点（无效内容不落库）；raw 上限 1MB；未绑定 KV 返回 501 + 配置指引而非 500 |
| 额度 | KV 免费档 1000 写/天 + 10 万读/天，写入仅在生成短链时发生，读取在客户端刷新订阅时，个人使用绰绰有余 |
| 安全 | 链接含节点凭据（UUID/密码），不可公开分享；KV 静态加密由 Cloudflare 提供 |

### 新增/变更文件

```
新增  src/app/api/shorten/route.ts    POST /api/shorten 短链接生成 API
新增  src/types/cloudflare.d.ts       KV 最小类型声明（KVNamespace/CloudflareEnv）
新增  src/styles/tw-animate.css       tw-animate-css v1.4.0 内联（修复构建）
新增  tests/subconv.test.ts           40 项核心功能回归测试（bun run tests/subconv.test.ts）
修改  src/app/api/sub/route.ts        支持 id= 短链参数；去重/重命名逻辑统一（GET 亦生效）；抽取公共函数
修改  src/app/page.tsx                短链接开关；生成流程重排（先校验→短链→二维码容错）；文案修正
修改  src/lib/sub-converter.ts        上述全部核心修复
修改  src/app/globals.css             tw-animate-css 改本地引入
修改  wrangler.toml                   SUBS_KV 绑定模板（注释状态，回填 id 即启用）
修改  next.config.ts                  移除 Next 16 已删除的 eslint 键
修改  DEPLOY.md                       短链接配置章节 + /api/shorten API 文档 + /api/sub 参数表更新
修改  package.json / bun.lock         devDependencies 增加 yaml（仅测试用）
修改  项目结构.md                      同步新文件
```

## 三、验证结果

| 验证项 | 结果 |
|--------|------|
| 功能回归测试（tests/subconv.test.ts，覆盖 9 大类） | ✅ 40/40 通过 |
| TypeScript 全量类型检查（tsc --noEmit） | ✅ 0 错误 |
| Cloudflare Pages 构建（bun run pages:build） | ✅ 成功 |
| wrangler pages dev 运行时实测 | ✅ 转换预览/GET 转换/短链生成/短链还原（200 YAML）/错误 ID（404）/未配 KV（501）全部符合预期 |

> 注意：本报告中的验证在本地完成；正式启用短链接仍需按上文步骤在 Cloudflare 创建 KV 并回填 id。
