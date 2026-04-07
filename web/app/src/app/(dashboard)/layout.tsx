"use client";

import { Header } from "@/components/layout/Header";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dark bg-background text-foreground min-h-screen">
      <Header />
      <main className="px-6 py-6">{children}</main>
    </div>
  );
}
