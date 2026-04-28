// Minimal CDP Proxy — listens on a local HTTP port and translates simple HTTP
// requests into Chrome DevTools Protocol commands over WebSocket.
//
// Why we have our own (instead of relying on chrome-remote-interface or similar):
//   - Zero npm dependencies (Node 22+ has native WebSocket).
//   - Sized to one ~250-line file.
//   - Always probes Chrome via /json/version, NEVER reads DevToolsActivePort
//     (sidesteps the stale-port cache class of bugs).
//
// Endpoints:
//   GET  /targets                          → list page tabs
//   GET  /new?url=<url>                    → open new tab, returns {targetId}
//   GET  /info?target=<id>                 → {url, title, ready}
//   GET  /navigate?target=<id>&url=<url>   → navigate target tab
//   POST /eval?target=<id>   body: <expr>  → eval JS in target, returns {value}
//   GET  /close?target=<id>                → close target tab

import http from "node:http";
import net from "node:net";

const DEFAULT_PORT = parseInt(process.env.CDP_PROXY_PORT || "3456", 10);
const CHROME_DEBUG_PORT = parseInt(process.env.CHROME_DEBUG_PORT || "9222", 10);

// ── runtime state ──
let ws = null;
let wsConnecting = null;
let nextMsgId = 1;
const pending = new Map();      // msgId → {resolve, reject}
const sessions = new Map();      // targetId → sessionId

// ── HTTP helpers ──
async function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
        catch (e) { reject(e); }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function checkPort(port, host = "127.0.0.1", timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.createConnection(port, host);
    const t = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(t); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(t); resolve(false); });
  });
}

// ── WebSocket connection to Chrome ──
async function connect() {
  if (ws && ws.readyState === 1) return;
  if (wsConnecting) return wsConnecting;

  wsConnecting = (async () => {
    // Always discover wsPath fresh — this is what makes us robust to
    // Chrome restarts (DevToolsActivePort cache would lie to us here).
    const v = await httpJson(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`);
    const wsUrl = v.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error("Chrome debug endpoint did not return webSocketDebuggerUrl");

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.addEventListener("open", () => {
        ws = socket;
        wsConnecting = null;
        resolve();
      }, { once: true });
      socket.addEventListener("error", (e) => {
        wsConnecting = null;
        reject(new Error(`Chrome WS connect failed: ${e.message || "unknown"}`));
      }, { once: true });
      socket.addEventListener("close", () => {
        ws = null;
        sessions.clear();
        for (const { reject } of pending.values()) reject(new Error("WS closed"));
        pending.clear();
      });
      socket.addEventListener("message", (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }

        // Track session attachments
        if (msg.method === "Target.attachedToTarget") {
          const { sessionId, targetInfo } = msg.params;
          sessions.set(targetInfo.targetId, sessionId);
        }

        if (msg.id != null && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      });
    });
  })();

  return wsConnecting;
}

function send(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    const id = nextMsgId++;
    pending.set(id, { resolve, reject });
    const payload = sessionId
      ? { id, method, params, sessionId }
      : { id, method, params };
    ws.send(JSON.stringify(payload));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
  });
}

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const r = await send("Target.attachToTarget", { targetId, flatten: true });
  if (r?.sessionId) {
    sessions.set(targetId, r.sessionId);
    return r.sessionId;
  }
  throw new Error("Target.attachToTarget failed");
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf-8");
}

// ── HTTP server ──
function startServer(port = DEFAULT_PORT) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const q = Object.fromEntries(url.searchParams);
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    try {
      await connect();

      switch (url.pathname) {
        case "/targets": {
          // Use CDP Target.getTargets so the field is `targetId` (matches the rest of our API).
          // /json/list returns Chrome's HTTP shape where the field is `id` instead.
          const r = await send("Target.getTargets");
          const pages = (r.targetInfos || []).filter(t => t.type === "page");
          res.end(JSON.stringify(pages));
          return;
        }
        case "/new": {
          const r = await send("Target.createTarget", {
            url: q.url || "about:blank",
            background: false,
          });
          res.end(JSON.stringify({ targetId: r.targetId }));
          return;
        }
        case "/close": {
          const r = await send("Target.closeTarget", { targetId: q.target });
          sessions.delete(q.target);
          res.end(JSON.stringify(r));
          return;
        }
        case "/info": {
          const sid = await ensureSession(q.target);
          const eval1 = await send("Runtime.evaluate", {
            expression: "JSON.stringify({url:location.href,title:document.title,ready:document.readyState})",
            returnByValue: true,
          }, sid);
          res.end(eval1.result?.value || "{}");
          return;
        }
        case "/navigate": {
          const sid = await ensureSession(q.target);
          await send("Page.enable", {}, sid);
          await send("Page.navigate", { url: q.url }, sid);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        case "/eval": {
          const expr = await readBody(req);
          const sid = await ensureSession(q.target);
          const r = await send("Runtime.evaluate", {
            expression: expr,
            returnByValue: true,
            awaitPromise: true,
          }, sid);
          if (r.exceptionDetails) {
            res.end(JSON.stringify({ error: r.exceptionDetails.text || "eval threw" }));
          } else {
            res.end(JSON.stringify({ value: r.result?.value }));
          }
          return;
        }
        case "/setFiles": {
          const body = JSON.parse(await readBody(req));
          const sid = await ensureSession(q.target);
          const docResult = await send("Runtime.evaluate", {
            expression: `document.querySelector(${JSON.stringify(body.selector)})`,
            returnByValue: false,
          }, sid);
          if (!docResult.result?.objectId) {
            res.end(JSON.stringify({ error: "selector not found" }));
            return;
          }
          const doc = await send("DOM.getDocument", {}, sid);
          const node = await send("DOM.querySelector", {
            nodeId: doc.root.nodeId,
            selector: body.selector,
          }, sid);
          await send("DOM.setFileInputFiles", {
            nodeId: node.nodeId,
            files: body.files,
          }, sid);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        default:
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "unknown endpoint" }));
      }
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.error(`[cdp-proxy] listening on http://127.0.0.1:${port} (Chrome → :${CHROME_DEBUG_PORT})`);
      resolve(server);
    });
  });
}

export { startServer, checkPort, DEFAULT_PORT, CHROME_DEBUG_PORT };

// CLI mode: `node lib/cdp-proxy.mjs`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
    import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  startServer().catch((e) => {
    console.error(`[cdp-proxy] failed: ${e.message}`);
    process.exit(1);
  });
}
