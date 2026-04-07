"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PortfolioPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Track your lending and borrowing positions on XRPL
        </p>
      </div>

      <Card className="border-border/40 bg-card/50">
        <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
          <svg className="w-12 h-12 text-muted-foreground/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <p className="text-sm text-muted-foreground">
            Connect your wallet to view your positions
          </p>
          <button className="rounded-lg bg-atlas hover:bg-atlas/80 px-6 py-2.5 text-sm font-medium text-white transition-colors">
            Connect Wallet
          </button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-border/40 bg-card/50">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Supplying</p>
            <p className="text-2xl font-semibold mt-1">0</p>
            <p className="text-xs text-muted-foreground mt-1">markets</p>
          </CardContent>
        </Card>
        <Card className="border-border/40 bg-card/50">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Borrowing</p>
            <p className="text-2xl font-semibold mt-1">0</p>
            <p className="text-xs text-muted-foreground mt-1">markets</p>
          </CardContent>
        </Card>
        <Card className="border-border/40 bg-card/50">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Net APY</p>
            <p className="text-2xl font-semibold mt-1">--</p>
            <p className="text-xs text-muted-foreground mt-1">connect to view</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/40 bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Supply Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-8 text-center">
            No supply positions found.{" "}
            <a href="/markets" className="text-atlas hover:underline">
              Explore markets
            </a>
          </p>
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Borrow Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-8 text-center">
            No borrow positions found
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
