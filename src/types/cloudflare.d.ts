/**
 * Cloudflare KV 最小类型声明
 * 项目通过 @cloudflare/next-on-pages 部署到 Pages，
 * 运行时通过 getRequestContext().env 获取绑定（如 SUBS_KV）。
 * 这里仅声明用到的能力，避免引入完整 workers-types。
 */
interface KVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Pages 项目可用的绑定环境（在 Cloudflare Dashboard / wrangler.toml 中配置） */
interface CloudflareEnv {
  /** 短链接存储：KV 命名空间绑定名固定为 SUBS_KV（见 DEPLOY.md） */
  SUBS_KV?: KVNamespace;
}
