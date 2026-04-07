"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
      <div className="grid h-16 grid-cols-[1fr_auto_1fr] items-center px-6">
        <Link href="/markets" className="flex items-center gap-2 justify-self-start">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-atlas">
            <span className="text-sm font-bold text-white">A</span>
          </div>
          <span className="text-lg font-semibold tracking-tight">Atlas</span>
          <span className="rounded-full bg-atlas/10 px-2 py-0.5 text-xs text-atlas">
            Beta
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                pathname === item.href
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="justify-self-end flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            XRPL
          </div>
          <button className="rounded-lg bg-atlas hover:bg-atlas/80 px-4 py-2 text-sm font-medium text-white transition-colors">
            Connect Wallet
          </button>
        </div>
      </div>
    </header>
  );
}
