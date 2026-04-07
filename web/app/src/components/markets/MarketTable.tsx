"use client";

import { useState, useMemo } from "react";
import Image from "next/image";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { type AtlasMarket, TOKEN_LOGOS, TOKEN_COLORS } from "@/config/markets";
import { formatTokenAmount, formatPercent } from "@/lib/format";

interface MarketTableProps {
  markets: AtlasMarket[];
}

type SortKey = "totalSupply" | "totalBorrows" | "supplyAPY" | "borrowAPY" | "utilization";
type SortDir = "asc" | "desc";

export function TokenIcon({ symbol, size = "md" }: { symbol: string; size?: "sm" | "md" | "lg" }) {
  const px = size === "sm" ? 24 : size === "lg" ? 36 : 28;
  const dims = size === "sm" ? "h-6 w-6" : size === "lg" ? "h-9 w-9" : "h-7 w-7";
  const logo = TOKEN_LOGOS[symbol];

  if (logo) {
    return (
      <Image
        src={logo}
        alt={symbol}
        width={px}
        height={px}
        className={`${dims} rounded-full object-cover shrink-0`}
      />
    );
  }

  const textSize = size === "sm" ? "text-[8px]" : size === "lg" ? "text-xs" : "text-[10px]";
  return (
    <div className={`flex items-center justify-center rounded-full ${TOKEN_COLORS[symbol] ?? "bg-muted"} ${dims} ${textSize} font-bold text-white shrink-0`}>
      {symbol.slice(0, 2).toUpperCase()}
    </div>
  );
}

function SortArrow({ active, direction }: { active: boolean; direction: SortDir }) {
  if (!active) {
    return (
      <svg className="w-3 h-3 text-muted-foreground/40 ml-1 shrink-0" viewBox="0 0 12 12" fill="currentColor">
        <path d="M6 2L9 5H3L6 2Z" />
        <path d="M6 10L3 7H9L6 10Z" />
      </svg>
    );
  }
  return (
    <svg className="w-3 h-3 text-foreground ml-1 shrink-0" viewBox="0 0 12 12" fill="currentColor">
      {direction === "asc" ? <path d="M6 2L9 6H3L6 2Z" /> : <path d="M6 10L3 6H9L6 10Z" />}
    </svg>
  );
}

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "totalSupply", label: "Total Supply" },
  { key: "totalBorrows", label: "Total Borrows" },
  { key: "supplyAPY", label: "Supply APY" },
  { key: "borrowAPY", label: "Borrow APY" },
  { key: "utilization", label: "Utilization" },
];

function getSortValue(market: AtlasMarket, key: SortKey): number {
  switch (key) {
    case "totalSupply": return Number(market.totalSupply) / 10 ** market.assetDecimals;
    case "totalBorrows": return Number(market.totalBorrows) / 10 ** market.assetDecimals;
    case "supplyAPY": return market.supplyAPY;
    case "borrowAPY": return market.borrowAPY;
    case "utilization": return market.utilization;
  }
}

export function MarketTable({ markets }: MarketTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("totalSupply");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    return [...markets].sort((a, b) => {
      const aVal = getSortValue(a, sortKey);
      const bVal = getSortValue(b, sortKey);
      return sortDir === "desc" ? bVal - aVal : aVal - bVal;
    });
  }, [markets, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  if (markets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <p className="text-sm">No markets found</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent border-border/50">
            <TableHead className="w-[280px]">Market</TableHead>
            {SORT_COLUMNS.map((col) => (
              <TableHead
                key={col.key}
                className="text-right cursor-pointer select-none hover:text-foreground transition-colors"
                onClick={() => handleSort(col.key)}
              >
                <div className="flex items-center justify-end">
                  {col.label}
                  <SortArrow active={sortKey === col.key} direction={sortDir} />
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((market) => (
            <TableRow key={market.id} className="border-border/30 hover:bg-accent/30">
              <TableCell>
                <div className="flex items-center gap-3">
                  <TokenIcon symbol={market.asset} />
                  <div>
                    <div className="font-medium text-sm leading-tight">{market.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                        {market.asset}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        LTV {market.ltv}%
                      </span>
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {formatTokenAmount(market.totalSupply, market.assetDecimals, 2)}{" "}
                <span className="text-muted-foreground text-xs">{market.asset}</span>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {formatTokenAmount(market.totalBorrows, market.assetDecimals, 2)}{" "}
                <span className="text-muted-foreground text-xs">{market.asset}</span>
              </TableCell>
              <TableCell className="text-right">
                <span className="font-mono text-sm text-emerald-400">
                  {formatPercent(market.supplyAPY)}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <span className="font-mono text-sm text-amber-400">
                  {formatPercent(market.borrowAPY)}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-atlas transition-all"
                      style={{ width: `${Math.min(market.utilization, 100)}%` }}
                    />
                  </div>
                  <span className="font-mono text-xs text-muted-foreground w-12 text-right">
                    {formatPercent(market.utilization, 1)}
                  </span>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
