/**
 * Structured logger with ISO timestamps.
 * Format: [ISO] [LEVEL] message {"key":"value",...}
 */

import { WAD } from "xrpl-lending-sdk";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export function log(
  level: LogLevel,
  msg: string,
  data?: Record<string, unknown>,
): void {
  const ts = new Date().toISOString();
  const dataStr = data && Object.keys(data).length > 0 ? " " + JSON.stringify(data) : "";
  const line = `[${ts}] [${level}] ${msg}${dataStr}`;

  if (level === "INFO") {
    process.stdout.write(line + "\n");
  } else {
    process.stderr.write(line + "\n");
  }
}

/**
 * Format a WAD-scaled USD bigint as a human-readable "$X.XX" string.
 * Truncated to 2 decimal places.
 */
export function formatWadUsd(wadValue: bigint): string {
  const wholeDollars = wadValue / WAD;
  const fractional = wadValue % WAD;
  // 2 decimal places: fractional * 100 / WAD
  const cents = (fractional * 100n) / WAD;
  return `$${wholeDollars}.${String(cents).padStart(2, "0")}`;
}
