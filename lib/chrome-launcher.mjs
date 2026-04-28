// Launch Chrome with remote debugging enabled, in an isolated user-data-dir
// so it doesn't conflict with the user's daily browser. The data-dir is
// stable (not PID-based) so cookies / login persist across runs.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { findChromeExecutable, getDefaultUserDataDir } from "./platform.mjs";
import { checkPort } from "./cdp-proxy.mjs";

const DEBUG_PORT = parseInt(process.env.CHROME_DEBUG_PORT || "9222", 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function chromeIsLive() {
  if (!(await checkPort(DEBUG_PORT))) return false;
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          resolve(!!v.webSocketDebuggerUrl);
        } catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

/**
 * Launch Chrome with remote debugging if not already running.
 * Returns when the debug endpoint responds (or throws on timeout).
 */
export async function ensureChromeRunning(opts = {}) {
  const {
    userDataDir = getDefaultUserDataDir(),
    waitTimeoutMs = 15000,
    extraArgs = [],
  } = opts;

  if (await chromeIsLive()) {
    console.error(`[chrome] Already running on :${DEBUG_PORT}`);
    return { reused: true, userDataDir };
  }

  const exe = findChromeExecutable();
  if (!exe) {
    throw new Error("Chrome executable not found. Install Chrome or set CHROME_PATH env var.");
  }

  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    ...extraArgs,
    "about:blank",
  ];

  console.error(`[chrome] Launching: ${exe}`);
  console.error(`[chrome] User data dir: ${userDataDir}`);

  const proc = spawn(exe, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  proc.unref();

  // Wait for debug endpoint
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await chromeIsLive()) {
      console.error(`[chrome] Ready on :${DEBUG_PORT}`);
      return { reused: false, userDataDir, pid: proc.pid };
    }
  }

  throw new Error(`Chrome did not become ready on :${DEBUG_PORT} within ${waitTimeoutMs}ms`);
}

export async function isChromeAlive() {
  return chromeIsLive();
}
