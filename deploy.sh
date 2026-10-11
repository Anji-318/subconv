#!/bin/bash
# SubConv Cloudflare Pages 一键部署脚本
set -e

echo "🚀 SubConv 订阅转换工具 - Cloudflare Pages 部署"
echo ""

# 检查登录状态
if ! npx wrangler whoami 2>&1 | grep -q "logged in\|Authenticated"; then
  echo "📋 第一步：登录 Cloudflare"
  echo "   浏览器会弹出授权页，点击 Allow"
  npx wrangler login
fi

echo ""
echo "🔨 第二步：构建生产版本"
bun run pages:build

echo ""
echo "🚀 第三步：部署到 Cloudflare Pages"
npx wrangler pages deploy .vercel/output/static --project-name=subconv

echo ""
echo "✅ 部署完成！"
echo "   访问地址：https://subconv.pages.dev"
echo "   自定义域名：Dashboard → Pages → subconv → Custom domains"
