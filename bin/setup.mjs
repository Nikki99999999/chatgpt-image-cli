#!/usr/bin/env node
// One-time setup: launch Chrome, start CDP proxy, walk user through login.
// Keeps proxy running in foreground (Ctrl+C to stop).

import http from "node:http";
import { ensureChromeRunning, isChromeAlive } from "../lib/chrome-launcher.mjs";
import { startServer, DEFAULT_PORT, checkPort } from "../lib/cdp-proxy.mjs";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
        catch (e) { resolve({ raw: Buffer.concat(chunks).toString("utf-8") }); }
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function postEval(target, expr) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: DEFAULT_PORT,
      path: `/eval?target=${target}`,
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(expr);
    req.end();
  });
}

async function main() {
  console.error("=".repeat(60));
  console.error("  chatgpt-image-cli · setup");
  console.error("=".repeat(60));

  // Step 1: Chrome
  console.error("\n[1/4] Checking Chrome with remote debugging...");
  await ensureChromeRunning();

  // Step 2: CDP proxy
  console.error("\n[2/4] Starting CDP proxy...");
  const proxyAlreadyRunning = await checkPort(DEFAULT_PORT);
  if (proxyAlreadyRunning) {
    console.error(`[proxy] Port ${DEFAULT_PORT} already in use — assuming proxy is running`);
  } else {
    await startServer();
  }

  await sleep(800);

  // Step 3: open ChatGPT and check login
  console.error("\n[3/4] Opening chatgpt.com to check login state...");
  const newResp = await fetchJson(`http://127.0.0.1:${DEFAULT_PORT}/new?url=https://chatgpt.com/`);
  const tid = newResp.targetId;
  if (!tid) {
    console.error("[ERR] Could not open tab. Exiting.");
    process.exit(1);
  }

  await sleep(4000);

  let loginState;
  for (let i = 0; i < 5; i++) {
    const r = await postEval(tid,
      'JSON.stringify({editor: !!document.getElementById("prompt-textarea"), loginBtn: document.querySelectorAll("[data-testid=login-button]").length})'
    );
    try {
      loginState = JSON.parse(r.value);
      if (loginState.editor || loginState.loginBtn !== undefined) break;
    } catch {}
    await sleep(2000);
  }

  if (!loginState || (loginState.loginBtn > 0 || !loginState.editor)) {
    console.error("\n  ⚠️  ChatGPT is NOT logged in.");
    console.error("\n  → A Chrome window has been opened to chatgpt.com.");
    console.error("  → Please complete login in that window (Google/email/SSO).");
    console.error("  → Cookies persist in the dedicated profile, so you only need to log in once.");
    console.error("\n  Polling login state every 8 seconds...\n");

    let logged = false;
    for (let i = 0; i < 60; i++) { // up to 8 minutes
      await sleep(8000);
      const r = await postEval(tid,
        'JSON.stringify({editor: !!document.getElementById("prompt-textarea"), loginBtn: document.querySelectorAll("[data-testid=login-button]").length})'
      );
      try {
        const s = JSON.parse(r.value);
        if (s.editor && s.loginBtn === 0) {
          console.error(`  ✓ Login detected after ${(i + 1) * 8}s`);
          logged = true;
          break;
        }
      } catch {}
      if (i % 4 === 3) console.error(`  ...still waiting (${(i + 1) * 8}s)`);
    }

    if (!logged) {
      console.error("\n[ERR] Login timed out after 8 minutes. Re-run setup when ready.");
      process.exit(1);
    }
  } else {
    console.error("  ✓ Already logged in");
  }

  // Step 4: Done
  console.error("\n[4/4] Setup complete.");
  console.error("\n" + "=".repeat(60));
  console.error("  ✅ Ready! From a NEW terminal, run:");
  console.error('     chatgpt-image -p "Generate an image: a red circle on white" -o test.jpg');
  console.error("\n  Keep this process alive — it hosts the CDP proxy.");
  console.error("  Ctrl+C to stop (Chrome keeps running independently).");
  console.error("=".repeat(60) + "\n");

  // Stay alive — we own the proxy
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`\n[ERR] ${e.message}`);
  process.exit(1);
});
