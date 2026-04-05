"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/components/wallet/WalletProvider";
import { ConnectModal } from "@/components/wallet/ConnectModal";
import { shortenAddress } from "@/lib/format";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/markets", label: "Markets" },
  { href: "/liquidations", label: "Liquidations" },
];

export function Topbar() {
  const pathname = usePathname();
  const { address, disconnect } = useWallet();
  const [connectOpen, setConnectOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  return (
    <>
      <header className="topbar sticky top-0 z-50 flex items-center justify-between px-6">
        {/* Logo */}
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-[#5e6ad2] flex items-center justify-center">
              <span className="text-white text-xs font-bold">XL</span>
            </div>
            <span className="text-[#f7f8f8] text-sm font-semibold tracking-tight">
              XRPL Lending
            </span>
          </Link>

          {/* Nav links */}
          <nav className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map(link => {
              const active = pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href));
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                    active
                      ? "text-[#f7f8f8] bg-white/[0.06]"
                      : "text-[#8a8f98] hover:text-[#d0d6e0] hover:bg-white/[0.03]"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3">
          {/* Network badge */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03]">
            <div className="w-1.5 h-1.5 rounded-full bg-[#10b981] animate-pulse" />
            <span className="text-xs text-[#8a8f98]">Simulated</span>
          </div>

          {/* Wallet button */}
          {address ? (
            <div className="relative">
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.05] text-sm text-[#d0d6e0] transition-colors"
              >
                <div className="w-2 h-2 rounded-full bg-[#10b981]" />
                {shortenAddress(address)}
              </button>
              {dropdownOpen && (
                <div className="absolute right-0 top-full mt-1 w-40 bg-[#191a1b] border border-white/10 rounded-lg p-1 shadow-lg z-50">
                  <button
                    onClick={() => { disconnect(); setDropdownOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-sm text-[#d0d6e0] hover:bg-white/[0.05] rounded-md"
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Button
              size="sm"
              onClick={() => setConnectOpen(true)}
              className="bg-[#5e6ad2] hover:bg-[#7170ff] text-white text-sm font-medium"
            >
              Connect Wallet
            </Button>
          )}
        </div>
      </header>

      <ConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </>
  );
}
