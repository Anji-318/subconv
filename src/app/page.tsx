'use client'

import { useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { toast } from 'sonner'
import {
  ArrowUpRight,
  Copy,
  Download,
  Gauge,
  Github,
  Loader2,
  QrCode,
  Server,
  Share2,
  ShieldCheck,
  Sparkles,
  Upload,
  Zap,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toaster as SonnerToaster } from '@/components/ui/sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Target = 'clash' | 'clashmeta' | 'singbox' | 'surge' | 'quantumultx' | 'loon' | 'v2ray' | 'mixed'
type TabKey = 'url' | 'raw'

interface PreviewNode {
  name: string
  protocol: string
  server: string
  port: number
  link?: string  // 节点原始链接（用于分享二维码）
}

interface PreviewResult {
  count: number
  nodes: PreviewNode[]
  dedupRemoved?: number
  unsupported?: { protocol: string; count: number }[]
}

const TARGET_LABELS: Record<Target, string> = {
  clash: 'Clash / Mihomo',
  clashmeta: 'Clash.Meta',
  singbox: 'sing-box',
  surge: 'Surge',
  quantumultx: 'QuantumultX',
  loon: 'Loon',
  v2ray: 'V2Ray (Base64)',
  mixed: '原始链接',
}

// 仅 Clash 系列支持自定义配置规则
const CONFIG_TARGETS: Target[] = ['clash', 'clashmeta']

// 远程规则集预设库（常用 subconverter ini 配置）
const CONFIG_PRESETS: { name: string; url: string; desc: string }[] = [
  { name: 'ACL4SSR_Online', url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini', desc: 'ACL4SSR 经典规则' },
  { name: 'ACL4SSR_Online_Full', url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_Full.ini', desc: 'ACL4SSR 完整版' },
  { name: 'ACL4SSR_Online_Mini', url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_Mini.ini', desc: 'ACL4SSR 精简版' },
  { name: 'ConnersHua_Online', url: 'https://raw.githubusercontent.com/ConnersHua/Profile/master/Clash/Conners.ini', desc: 'ConnersHua 规则' },
  { name: 'lhie1_Rules', url: 'https://raw.githubusercontent.com/lhie1/Rules/master/Clash/Clash.ini', desc: 'lhie1 规则集' },
]

const PROTOCOL_BADGE: Record<string, string> = {
  vless: 'border-teal-500/30 bg-teal-500/15 text-teal-300',
  vmess: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
  trojan: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  ss: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300',
}

function ProtocolBadge({ protocol }: { protocol: string }) {
  const cls = PROTOCOL_BADGE[protocol] ?? PROTOCOL_BADGE.ss
  return (
    <Badge
      variant="outline"
      className={cn('font-mono text-[10px] uppercase tracking-wide', cls)}
    >
      {protocol}
    </Badge>
  )
}

export default function Home() {
  const [tab, setTab] = useState<TabKey>('url')
  const [urlInput, setUrlInput] = useState('')
  const [rawInput, setRawInput] = useState('')
  const [target, setTarget] = useState<Target>('clash')
  const [name, setName] = useState('订阅转换')
  const [configMode, setConfigMode] = useState<'default' | 'custom' | 'remote'>('default')
  const [configUrl, setConfigUrl] = useState('')
  const [configRaw, setConfigRaw] = useState('')
  const [dedup, setDedup] = useState(false)
  const [renamePrefix, setRenamePrefix] = useState('')
  const [renameMode, setRenameMode] = useState<'none' | 'prefix-seq' | 'keep-seq' | 'prefix-only'>('none')

  const [loading, setLoading] = useState(false)
  const [subLink, setSubLink] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [speedTesting, setSpeedTesting] = useState(false)
  const [speedResults, setSpeedResults] = useState<{ name: string; delay: number | null; ok: boolean }[] | null>(null)
  const [shareNode, setShareNode] = useState<PreviewNode | null>(null)
  const [shareQr, setShareQr] = useState<string | null>(null)

  const canGenerate = useMemo(() => {
    if (loading) return false
    return tab === 'url' ? urlInput.trim().length > 0 : rawInput.trim().length > 0
  }, [loading, tab, urlInput, rawInput])

  const canSpeedTest = useMemo(() => {
    if (speedTesting) return false
    return tab === 'url' ? urlInput.trim().length > 0 : rawInput.trim().length > 0
  }, [speedTesting, tab, urlInput, rawInput])

  /** 解析当前输入为 API 参数 */
  function buildParams(): { url?: string; raw?: string } | null {
    if (tab === 'url') {
      const urls = urlInput
        .split(/[\n|]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (urls.length === 0) return null
      return { url: urls.join('|') }
    }
    const raw = rawInput.trim()
    if (!raw) return null
    return { raw }
  }

  /** 构造 GET 订阅链接（用户真正导入客户端的链接） */
  function buildSubLink(): string | null {
    const params = buildParams()
    if (!params) return null
    const qs = new URLSearchParams()
    qs.set('target', target)
    qs.set('name', name.trim() || '订阅转换')
    if (params.url) qs.set('url', params.url)
    if (params.raw) qs.set('raw', params.raw)
    if (configMode === 'remote' && configUrl.trim()) qs.set('config', configUrl.trim())
    if (configMode === 'custom' && configRaw.trim()) qs.set('configRaw', configRaw.trim())
    const origin =
      typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}/api/sub?${qs.toString()}`
  }

  async function handleGenerate() {
    const link = buildSubLink()
    if (!link) {
      toast.error('请先输入订阅链接或节点内容')
      return
    }

    setLoading(true)
    setError(null)
    setSubLink(null)
    setQrDataUrl(null)
    setPreview(null)

    try {
      // 1. 生成二维码（基于订阅链接）
      const qr = await QRCode.toDataURL(link, {
        width: 200,
        margin: 1,
        errorCorrectionLevel: 'M',
      })
      setQrDataUrl(qr)
      setSubLink(link)

      // 2. 调用 POST 预览，获取节点统计
      const params = buildParams()!
      const configBody: { configUrl?: string; configRaw?: string } = {}
      if (configMode === 'remote' && configUrl.trim()) configBody.configUrl = configUrl.trim()
      if (configMode === 'custom' && configRaw.trim()) configBody.configRaw = configRaw.trim()
      const res = await fetch('/api/sub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          name: name.trim() || '订阅转换',
          ...params,
          ...configBody,
          dedup,
          ...(renameMode !== 'none' ? { renamePrefix: renamePrefix.trim(), renameMode } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `请求失败 (${res.status})`)
      }
      setPreview({
        count: data.count as number,
        nodes: (data.nodes as PreviewNode[]) ?? [],
        dedupRemoved: data.dedupRemoved as number | undefined,
        unsupported: data.unsupported as { protocol: string; count: number }[] | undefined,
      })
      const parts = [`已解析 ${data.count} 个节点`]
      if (data.dedupRemoved) parts.push(`去重 ${data.dedupRemoved} 个`)
      if (data.unsupported?.length) parts.push(`${data.unsupported.reduce((s: number, u: { count: number }) => s + u.count, 0)} 个不支持`)
      toast.success(parts.join(' · '))
    } catch (e) {
      const msg = (e as Error).message || '生成失败'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  async function handleCopy(text: string, label = '已复制到剪贴板') {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(label)
    } catch {
      toast.error('复制失败，请手动选择文本复制')
    }
  }

  /** 导出当前自定义配置为 ini 文件 */
  function handleExportConfig() {
    if (!configRaw.trim()) { toast.error('自定义配置为空'); return }
    const blob = new Blob([configRaw], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'subconv-config.ini'; a.click()
    URL.revokeObjectURL(url)
    toast.success('配置已导出')
  }

  /** 导入 ini 文件 */
  function handleImportConfig(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => { setConfigRaw(String(reader.result || '')); toast.success(`已导入 ${file.name}`) }
    reader.onerror = () => toast.error('导入失败')
    reader.readAsText(file)
    e.target.value = ''
  }

  /** 节点测速 */
  async function handleSpeedTest() {
    const params = buildParams()
    if (!params) { toast.error('请先输入节点'); return }
    setSpeedTesting(true)
    setSpeedResults(null)
    try {
      const res = await fetch('/api/speedtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, timeout: 5000, concurrency: 8 }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.success) throw new Error(data?.error || `测速失败 (${res.status})`)
      setSpeedResults((data.results as { name: string; delay: number | null; ok: boolean }[]).map(r => ({ name: r.name, delay: r.delay, ok: r.ok })))
      toast.success(`测速完成：${data.ok}/${data.total} 可达${data.avgDelay ? `，均速 ${data.avgDelay}ms` : ''}`)
    } catch (e) {
      toast.error((e as Error).message || '测速失败')
    } finally {
      setSpeedTesting(false)
    }
  }

  /** 分享单个节点：生成二维码弹窗 */
  async function handleShareNode(n: PreviewNode) {
    if (!n.link) { toast.error('该节点不支持分享链接'); return }
    setShareNode(n)
    setShareQr(null)
    try {
      const qr = await QRCode.toDataURL(n.link, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
      setShareQr(qr)
    } catch {
      toast.error('二维码生成失败')
    }
  }

  const visibleNodes = preview ? preview.nodes.slice(0, 10) : []

  return (
    <div className="dark subconv relative min-h-dvh bg-background text-foreground">
      {/* Hero 渐变背景层 */}
      <div
        aria-hidden
        className="subconv-hero pointer-events-none absolute inset-x-0 top-0 h-[420px]"
      />

      <SonnerToaster
        theme="dark"
        position="bottom-center"
        richColors
        closeButton
      />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 sm:px-6">
        {/* ============ Header ============ */}
        <header className="flex items-center justify-between gap-4 py-6 sm:py-8">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 to-emerald-500 shadow-lg shadow-teal-500/30 ring-1 ring-white/10">
              <Zap className="size-5 text-black" strokeWidth={2.5} />
            </div>
            <div className="leading-tight">
              <h1 className="text-base font-semibold tracking-tight sm:text-lg">
                SubConv · 订阅转换
              </h1>
              <p className="text-xs text-muted-foreground">
                订阅链接 / 节点 → Clash · sing-box · V2Ray
              </p>
            </div>
          </div>
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground hover:bg-teal-500/10"
          >
            <a href="#" aria-label="GitHub 仓库" target="_blank" rel="noreferrer">
              <Github className="size-5" />
            </a>
          </Button>
        </header>

        {/* ============ 主体 ============ */}
        <main className="flex flex-1 flex-col gap-6 pb-10">
          {/* 输入 + 配置卡 */}
          <Card className="subconv-fade-up border-white/10 bg-card/60 shadow-2xl shadow-black/20 backdrop-blur-sm">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-teal-300" />
                <CardTitle className="text-base">转换配置</CardTitle>
              </div>
              <CardDescription>
                输入订阅链接或直接粘贴节点，选择目标格式后一键生成。
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5">
              {/* 输入区 Tabs */}
              <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as TabKey)}
                className="w-full"
              >
                <TabsList className="bg-muted/60 h-9 w-full justify-start gap-1">
                  <TabsTrigger
                    value="url"
                    className="data-[state=active]:bg-teal-500/15 data-[state=active]:text-teal-200 data-[state=active]:shadow-none"
                  >
                    订阅链接
                  </TabsTrigger>
                  <TabsTrigger
                    value="raw"
                    className="data-[state=active]:bg-teal-500/15 data-[state=active]:text-teal-200 data-[state=active]:shadow-none"
                  >
                    节点内容
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="url" className="mt-3">
                  <Label htmlFor="url-input" className="mb-1.5 block text-sm">
                    订阅 URL
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      多个链接用换行或 | 分隔
                    </span>
                  </Label>
                  <Textarea
                    id="url-input"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder={
                      'https://example.com/sub1\nhttps://example.com/sub2'
                    }
                    className="min-h-[110px] resize-y font-mono text-xs leading-relaxed"
                    spellCheck={false}
                  />
                </TabsContent>

                <TabsContent value="raw" className="mt-3">
                  <Label htmlFor="raw-input" className="mb-1.5 block text-sm">
                    节点链接
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      vless / vmess / trojan / ss，每行一个
                    </span>
                  </Label>
                  <Textarea
                    id="raw-input"
                    value={rawInput}
                    onChange={(e) => setRawInput(e.target.value)}
                    placeholder={
                      'vless://uuid@server:443?...\nvmess://eyJh...\ntrojan://password@server:443\nss://...'
                    }
                    className="min-h-[110px] resize-y font-mono text-xs leading-relaxed"
                    spellCheck={false}
                  />
                </TabsContent>
              </Tabs>

              {/* 配置区 2 列 */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="target-select" className="text-sm">
                    目标格式
                  </Label>
                  <Select
                    value={target}
                    onValueChange={(v) => setTarget(v as Target)}
                  >
                    <SelectTrigger id="target-select" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="clash">Clash / Mihomo</SelectItem>
                      <SelectItem value="clashmeta">Clash.Meta (Experimental)</SelectItem>
                      <SelectItem value="singbox">sing-box</SelectItem>
                      <SelectItem value="surge">Surge</SelectItem>
                      <SelectItem value="quantumultx">QuantumultX</SelectItem>
                      <SelectItem value="loon">Loon</SelectItem>
                      <SelectItem value="v2ray">V2Ray (Base64)</SelectItem>
                      <SelectItem value="mixed">原始链接 (Mixed)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="name-input" className="text-sm">
                    订阅名称
                  </Label>
                  <Input
                    id="name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="订阅转换"
                  />
                </div>
              </div>

              {/* 高级选项区：去重 + 重命名 */}
              <div className="space-y-2.5 rounded-lg border border-white/10 bg-muted/20 p-3.5">
                <Label className="text-sm font-medium">节点处理</Label>
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <Switch checked={dedup} onCheckedChange={setDedup} />
                    <span>去重（按 server:port）</span>
                  </label>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">重命名:</span>
                    <Select value={renameMode} onValueChange={(v) => setRenameMode(v as typeof renameMode)}>
                      <SelectTrigger className="h-7 w-[120px] text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">不重命名</SelectItem>
                        <SelectItem value="prefix-seq">前缀+序号</SelectItem>
                        <SelectItem value="keep-seq">原名+序号</SelectItem>
                        <SelectItem value="prefix-only">前缀+原名</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {renameMode !== 'none' && renameMode !== 'keep-seq' && (
                    <Input
                      value={renamePrefix}
                      onChange={(e) => setRenamePrefix(e.target.value)}
                      placeholder="前缀（如 节点）"
                      className="h-7 w-[140px] text-xs"
                    />
                  )}
                </div>
              </div>

              {/* 配置规则区 */}
              <div className="space-y-2.5 rounded-lg border border-white/10 bg-muted/20 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm font-medium">配置规则</Label>
                  <Select value={configMode} onValueChange={(v) => setConfigMode(v as 'default' | 'custom' | 'remote')} disabled={!CONFIG_TARGETS.includes(target)}>
                    <SelectTrigger className="h-8 w-[180px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">默认配置</SelectItem>
                      <SelectItem value="custom">自定义规则</SelectItem>
                      <SelectItem value="remote">远程规则 URL</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {!CONFIG_TARGETS.includes(target) && (
                  <p className="text-xs text-amber-400/80">
                    当前格式（{TARGET_LABELS[target]}）使用内置精简规则，自定义配置规则仅 Clash / Clash.Meta 生效。
                  </p>
                )}
                {CONFIG_TARGETS.includes(target) && configMode === 'default' && (
                  <p className="text-xs text-muted-foreground">
                    内置默认：10 个策略组 + 100+ 条规则（AI/媒体/社交/苹果/微软/开发者/Telegram 全覆盖）。
                  </p>
                )}
                {CONFIG_TARGETS.includes(target) && configMode === 'remote' && (
                  <div className="space-y-2">
                    <Input
                      value={configUrl}
                      onChange={(e) => setConfigUrl(e.target.value)}
                      placeholder="https://raw.githubusercontent.com/.../config.ini"
                      className="text-xs"
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {CONFIG_PRESETS.map((p) => (
                        <button
                          key={p.name}
                          type="button"
                          onClick={() => setConfigUrl(p.url)}
                          title={p.desc}
                          className={cn(
                            'rounded-md border px-2 py-1 text-[11px] transition-colors',
                            configUrl === p.url
                              ? 'border-teal-500/50 bg-teal-500/15 text-teal-200'
                              : 'border-white/10 bg-background/40 text-muted-foreground hover:border-teal-500/30 hover:text-teal-300'
                          )}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      点击预设一键填入，或手动填写 subconverter ini 格式 URL。
                    </p>
                  </div>
                )}
                {CONFIG_TARGETS.includes(target) && configMode === 'custom' && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs text-muted-foreground">subconverter ini 配置</Label>
                      <div className="flex gap-1.5">
                        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-white/10 bg-background/40 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-teal-500/30 hover:text-teal-300">
                          <Upload className="size-3" />
                          导入
                          <input type="file" accept=".ini,.conf,.txt,text/plain" onChange={handleImportConfig} className="hidden" />
                        </label>
                        <button
                          type="button"
                          onClick={handleExportConfig}
                          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-background/40 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-teal-500/30 hover:text-teal-300"
                        >
                          <Download className="size-3" />
                          导出
                        </button>
                      </div>
                    </div>
                    <Textarea
                      value={configRaw}
                      onChange={(e) => setConfigRaw(e.target.value)}
                      placeholder={'[custom_proxy_group]\n🚀 节点选择`select`[]♻️ 自动选择`[].*`[]🎯 全球直连\n♻️ 自动选择`url-test`[].*`http://www.gstatic.com/generate_204`300,50\n\n[ruleset]\nGitHub,https://raw.githubusercontent.com/.../github.ini,🚀 节点选择\n\n[custom_rule]\nDOMAIN-SUFFIX,google.com,🚀 节点选择\nGEOIP,CN,🎯 全球直连\nMATCH,🐟 漏网之鱼'}
                      className="min-h-[120px] font-mono text-xs"
                    />
                    <p className="text-xs text-muted-foreground">
                      粘贴 subconverter ini 格式配置，支持 [custom_proxy_group] / [ruleset] / [custom_rule] 三个段。
                    </p>
                  </div>
                )}
              </div>

              {/* 生成 + 测速按钮 */}
              <div className="flex gap-2.5">
                <Button
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  size="lg"
                  className="subconv-generate h-12 flex-1 gap-2 border-0 text-base font-semibold disabled:opacity-50"
                >
                  {loading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      正在转换…
                    </>
                  ) : (
                    <>
                      <Zap className="size-4" strokeWidth={2.5} />
                      生成订阅
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleSpeedTest}
                  disabled={!canSpeedTest}
                  variant="outline"
                  size="lg"
                  className="h-12 gap-2 border-white/15 bg-background/40 text-sm font-medium text-teal-200 hover:border-teal-500/40 hover:bg-teal-500/10 hover:text-teal-100 disabled:opacity-50"
                >
                  {speedTesting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      测速中…
                    </>
                  ) : (
                    <>
                      <Gauge className="size-4" />
                      节点测速
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ============ 结果区 ============ */}
          {subLink && (
            <Card className="subconv-fade-up border-white/10 bg-card/60 shadow-2xl shadow-black/20 backdrop-blur-sm">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <QrCode className="size-4 text-emerald-300" />
                  <CardTitle className="text-base">转换结果</CardTitle>
                </div>
                <CardDescription>
                  复制订阅链接导入客户端，或扫描二维码快速添加。
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-6">
                {/* 订阅链接行 */}
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                    订阅链接
                  </Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      readOnly
                      value={subLink}
                      className="flex-1 font-mono text-xs"
                      onClick={(e) =>
                        (e.currentTarget as HTMLInputElement).select()
                      }
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => handleCopy(subLink, '订阅链接已复制')}
                        className="border-teal-500/30 bg-teal-500/10 text-teal-200 hover:bg-teal-500/20 hover:text-teal-100"
                      >
                        <Copy className="size-4" />
                        复制
                      </Button>
                      <Button
                        variant="outline"
                        asChild
                        className="border-white/10 hover:bg-accent"
                      >
                        <a href={subLink} target="_blank" rel="noreferrer">
                          <ArrowUpRight className="size-4" />
                          打开
                        </a>
                      </Button>
                    </div>
                  </div>
                </div>

                {/* 二维码 + 节点统计 */}
                <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr] md:items-start">
                  {/* 二维码 */}
                  <div className="flex flex-col items-center gap-2">
                    <div className="subconv-qr flex size-[200px] items-center justify-center rounded-2xl p-3">
                      {qrDataUrl ? (
                        <img
                          src={qrDataUrl}
                          alt="订阅二维码"
                          className="size-full rounded-md"
                        />
                      ) : (
                        <Loader2 className="size-6 animate-spin text-zinc-400" />
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      扫码快速导入
                    </span>
                  </div>

                  {/* 节点统计 */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Server className="size-4 text-teal-300" />
                      <span className="text-sm font-medium">
                        {error ? (
                          <span className="text-destructive">
                            转换失败：{error}
                          </span>
                        ) : preview ? (
                          <>
                            解析到{' '}
                            <span className="text-teal-300">
                              {preview.count}
                            </span>{' '}
                            个节点
                          </>
                        ) : (
                          '正在解析节点…'
                        )}
                      </span>
                    </div>

                    {preview?.unsupported && preview.unsupported.length > 0 && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        <span className="mt-0.5">⚠️</span>
                        <span>
                          {TARGET_LABELS[target]} 不支持{' '}
                          {preview.unsupported.map(u => `${u.protocol}×${u.count}`).join('、')}{' '}
                          协议，已自动跳过。建议改用 Clash / sing-box / V2Ray 格式以保留全部节点。
                        </span>
                      </div>
                    )}

                    {preview && visibleNodes.length > 0 && (
                      <div className="subconv-scroll max-h-[260px] space-y-1.5 overflow-y-auto pr-1">
                        {visibleNodes.map((n, i) => (
                          <div
                            key={`${n.server}-${i}`}
                            className="flex items-center gap-2.5 rounded-lg border border-white/5 bg-background/40 px-2.5 py-1.5"
                          >
                            <ProtocolBadge protocol={n.protocol} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium">
                                {n.name || '(未命名)'}
                              </div>
                              <div className="truncate font-mono text-[10px] text-muted-foreground">
                                {n.server}:{n.port}
                              </div>
                            </div>
                            {n.link && (
                              <button
                                type="button"
                                onClick={() => handleShareNode(n)}
                                title="分享节点二维码"
                                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-teal-500/15 hover:text-teal-300"
                              >
                                <Share2 className="size-3.5" />
                              </button>
                            )}
                          </div>
                        ))}
                        {preview.count > 10 && (
                          <div className="pt-1 text-center text-[11px] text-muted-foreground">
                            还有 {preview.count - 10} 个节点未展示…
                          </div>
                        )}
                      </div>
                    )}

                    {loading && !preview && !error && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        正在拉取并解析节点…
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ============ 测速结果区 ============ */}
          {speedResults && (
            <Card className="subconv-fade-up border-white/10 bg-card/60 shadow-2xl shadow-black/20 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Gauge className="size-4 text-teal-300" />
                  节点测速结果
                </CardTitle>
                <CardDescription className="text-xs">
                  按 TCP 建连延迟排序（非真实代理延迟，仅作可达性参考）
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="subconv-scroll max-h-[320px] space-y-1 overflow-y-auto pr-1">
                  {speedResults.slice(0, 50).map((r, i) => (
                    <div
                      key={`${r.name}-${i}`}
                      className="flex items-center gap-2.5 rounded-lg border border-white/5 bg-background/40 px-2.5 py-1.5"
                    >
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">#{String(i + 1).padStart(2, '0')}</span>
                      <div className="min-w-0 flex-1 truncate text-xs font-medium">{r.name}</div>
                      {r.ok ? (
                        <span className={cn(
                          'shrink-0 font-mono text-[11px] tabular-nums',
                          (r.delay ?? 9999) < 300 ? 'text-emerald-300' : (r.delay ?? 9999) < 1000 ? 'text-amber-300' : 'text-zinc-400'
                        )}>
                          {r.delay}ms
                        </span>
                      ) : (
                        <span className="shrink-0 font-mono text-[11px] text-red-400">超时</span>
                      )}
                    </div>
                  ))}
                </div>
                {speedResults.length > 50 && (
                  <div className="pt-2 text-center text-[11px] text-muted-foreground">
                    还有 {speedResults.length - 50} 个节点未展示…
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </main>

        {/* ============ 节点分享弹窗 ============ */}
        <Dialog open={!!shareNode} onOpenChange={(v) => !v && (setShareNode(null), setShareQr(null))}>
          <DialogContent className="max-w-sm border-white/10 bg-card/95 backdrop-blur">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Share2 className="size-4 text-teal-300" />
                节点分享
              </DialogTitle>
            </DialogHeader>
            {shareNode && (
              <div className="space-y-3">
                <div className="rounded-lg border border-white/5 bg-background/40 p-2.5">
                  <div className="truncate text-sm font-medium">{shareNode.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{shareNode.server}:{shareNode.port} · {shareNode.protocol}</div>
                </div>
                <div className="flex justify-center">
                  <div className="subconv-qr flex size-[240px] items-center justify-center rounded-xl bg-white p-3">
                    {shareQr ? (
                      <img src={shareQr} alt="节点二维码" className="size-full rounded-md" />
                    ) : (
                      <Loader2 className="size-6 animate-spin text-zinc-400" />
                    )}
                  </div>
                </div>
                {shareNode.link && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <Input
                        readOnly
                        value={shareNode.link}
                        className="h-8 flex-1 font-mono text-[10px]"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 shrink-0 border-teal-500/30 text-teal-300 hover:bg-teal-500/10"
                        onClick={() => handleCopy(shareNode.link!, '节点链接已复制')}
                      >
                        <Copy className="size-3" />
                      </Button>
                    </div>
                    <p className="text-center text-[11px] text-muted-foreground">扫码或复制链接导入客户端</p>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* ============ Footer ============ */}
        <footer className="mt-auto border-t border-white/5 py-6 text-center">
          <div className="flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground sm:flex-row sm:gap-4">
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-teal-400" />
              <span>本地即时转换，不存储任何订阅内容</span>
            </div>
            <span className="hidden sm:inline">·</span>
            <span>
              © {new Date().getFullYear()} SubConv · 基于 Clash / sing-box / V2Ray
            </span>
          </div>
        </footer>
      </div>
    </div>
  )
}
