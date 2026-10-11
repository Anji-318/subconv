import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SubConv · 订阅转换工具",
  description: "支持 Clash/sing-box/Surge/QuantumultX/Loon/V2Ray 等 8 种格式互转，含节点测速、去重、重命名、分享二维码",
  keywords: ["订阅转换", "SubConv", "Clash", "sing-box", "Surge", "QuantumultX", "Loon", "V2Ray"],
  authors: [{ name: "SubConv" }],
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}>
        {children}
      </body>
    </html>
  );
}
