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
  title: "OPS · Personal Work OS",
  description: "在飞书里查看任务、Agent 进度、问题、产物和回执。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "OPS · 飞书端内战情桌",
    description: "任务是主体，Agent 的进度与回执回到飞书工作流。",
  },
  twitter: {
    card: "summary",
    title: "OPS · 飞书端内战情桌",
    description: "任务是主体，Agent 的进度与回执回到飞书工作流。",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
