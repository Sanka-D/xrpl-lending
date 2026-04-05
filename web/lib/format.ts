import { WAD, BPS, ASSET_DECIMALS, AssetIndex } from "./constants";

/** WAD bigint → decimal number */
export function wadToNumber(wad: bigint): number {
  return Number(wad) / Number(WAD);
}

/** WAD bigint → formatted % string (e.g. "4.20%") */
export function wadToPercent(wad: bigint, decimals = 2): string {
  return (wadToNumber(wad) * 100).toFixed(decimals) + "%";
}

/** BPS number → formatted % string (e.g. "4.00%") */
export function bpsToPercent(bps: number | bigint, decimals = 2): string {
  return (Number(bps) / 100).toFixed(decimals) + "%";
}

/** Native units → human-readable decimal token amount */
export function nativeToDisplay(
  amount: bigint,
  asset: AssetIndex,
  decimals = 4,
): string {
  const dec = ASSET_DECIMALS[asset];
  const divisor = 10n ** BigInt(dec);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const fracStr = frac.toString().padStart(dec, "0").slice(0, decimals);
  return `${whole}.${fracStr}`;
}

/** Native units → USD display using WAD-scaled price */
export function nativeToUsd(
  amount: bigint,
  priceWad: bigint,
  asset: AssetIndex,
): number {
  const dec = ASSET_DECIMALS[asset];
  const divisor = 10n ** BigInt(dec);
  const usd = (amount * priceWad) / divisor / WAD;
  return Number(usd);
}

/** WAD bigint → USD display string (e.g. "$1,234.56") */
export function usdDisplay(usdWad: bigint): string {
  const usd = Number(usdWad) / Number(WAD);
  return "$" + usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Raw USD number → display string */
export function formatUsd(usd: number): string {
  return "$" + usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Health factor WAD bigint → display string (e.g. "1.85") */
export function formatHF(hf: bigint): string {
  if (hf >= 2n ** 64n) return "∞"; // infinity sentinel
  const n = Number(hf) / Number(WAD);
  return n.toFixed(2);
}

/** Health factor → CSS class for coloring */
export function hfClass(hf: bigint): string {
  if (hf >= 2n ** 64n) return "hf-safe";
  const n = Number(hf) / Number(WAD);
  if (n >= 2.0) return "hf-safe";
  if (n >= 1.2) return "hf-warn";
  return "hf-danger";
}

/** Health factor → hex color */
export function hfColor(hf: bigint): string {
  if (hf >= 2n ** 64n) return "#10b981";
  const n = Number(hf) / Number(WAD);
  if (n >= 2.0) return "#10b981";
  if (n >= 1.2) return "#f59e0b";
  return "#ef4444";
}

/** Utilization as 0-100 percent number */
export function utilizationPercent(totalBorrows: bigint, totalSupply: bigint): number {
  const total = totalBorrows + totalSupply;
  if (total === 0n) return 0;
  return Number((totalBorrows * 10_000n) / total) / 100;
}

/** Shorten address: rXXXXXXXX...XXXX */
export function shortenAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return addr.slice(0, 8) + "..." + addr.slice(-4);
}

/** User-input token string → native bigint (e.g. "1.5" XRP → 1_500_000n) */
export function parseTokenInput(input: string, asset: AssetIndex): bigint {
  const dec = ASSET_DECIMALS[asset];
  const [wholePart, fracPart = ""] = input.replace(",", ".").split(".");
  const whole = BigInt(wholePart || "0");
  const frac = fracPart.slice(0, dec).padEnd(dec, "0");
  return whole * (10n ** BigInt(dec)) + BigInt(frac);
}
