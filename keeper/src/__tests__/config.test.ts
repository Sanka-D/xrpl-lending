import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config";
import { WAD } from "xrpl-lending-sdk";

// Helper: set env vars and restore after each test
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("loadConfig", () => {
  it("throws when CONTROLLER_ADDRESS is missing", () => {
    withEnv({ KEEPER_WALLET_SECRET: "s...", CONTROLLER_ADDRESS: undefined }, () => {
      expect(() => loadConfig(["--dry-run"])).toThrow(/CONTROLLER_ADDRESS/);
    });
  });

  it("throws when wallet secret missing and not dry-run", () => {
    withEnv({ KEEPER_WALLET_SECRET: undefined, CONTROLLER_ADDRESS: "rXXX" }, () => {
      expect(() => loadConfig([])).toThrow(/KEEPER_WALLET_SECRET/);
    });
  });

  it("allows missing wallet secret in dry-run mode", () => {
    withEnv({
      KEEPER_WALLET_SECRET: undefined,
      CONTROLLER_ADDRESS: "rXXX",
      MONITORED_ACCOUNTS: "rAlice",
    }, () => {
      const config = loadConfig(["--dry-run"]);
      expect(config.dryRun).toBe(true);
      expect(config.walletSecret).toBeUndefined();
    });
  });

  it("parses --dry-run flag", () => {
    withEnv({
      KEEPER_WALLET_SECRET: "sseed",
      CONTROLLER_ADDRESS: "rXXX",
      MONITORED_ACCOUNTS: "rAlice",
    }, () => {
      const config = loadConfig(["--dry-run"]);
      expect(config.dryRun).toBe(true);
    });
  });

  it("dry-run is false without flag", () => {
    withEnv({
      KEEPER_WALLET_SECRET: "sseed",
      CONTROLLER_ADDRESS: "rXXX",
      MONITORED_ACCOUNTS: "rAlice",
    }, () => {
      const config = loadConfig([]);
      expect(config.dryRun).toBe(false);
    });
  });

  it("parses comma-separated monitored accounts", () => {
    withEnv({
      KEEPER_WALLET_SECRET: "sseed",
      CONTROLLER_ADDRESS: "rXXX",
      MONITORED_ACCOUNTS: "rAlice,rBob,rCarol",
    }, () => {
      const config = loadConfig(["--dry-run"]);
      expect(config.monitoredAccounts).toEqual(["rAlice", "rBob", "rCarol"]);
    });
  });

  it("uses default MIN_PROFIT_USD of $10", () => {
    withEnv({
      KEEPER_WALLET_SECRET: "sseed",
      CONTROLLER_ADDRESS: "rXXX",
      MONITORED_ACCOUNTS: "rAlice",
      MIN_PROFIT_USD: undefined,
    }, () => {
      const config = loadConfig(["--dry-run"]);
      expect(config.minProfitUsd).toBe(10n * WAD);
    });
  });

  it("overrides MIN_PROFIT_USD from env", () => {
    withEnv({
      KEEPER_WALLET_SECRET: "sseed",
      CONTROLLER_ADDRESS: "rXXX",
      MONITORED_ACCOUNTS: "rAlice",
      MIN_PROFIT_USD: "25",
    }, () => {
      const config = loadConfig(["--dry-run"]);
      expect(config.minProfitUsd).toBe(25n * WAD);
    });
  });

  it("uses custom WSS URL from env", () => {
    withEnv({
      KEEPER_WALLET_SECRET: "sseed",
      CONTROLLER_ADDRESS: "rXXX",
      MONITORED_ACCOUNTS: "rAlice",
      XRPL_WSS_URL: "wss://custom.node.example",
    }, () => {
      const config = loadConfig(["--dry-run"]);
      expect(config.wsUrl).toBe("wss://custom.node.example");
    });
  });
});
