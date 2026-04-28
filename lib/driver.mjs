// ChatGPT Image 2.0 driver — talks to a running CDP proxy and produces an image.
//
// Public entry: generateImage({ prompt, output, edit, proxyUrl })
//
// Lessons baked in (see README "Pitfalls" section for context):
//   #1  CDP proxy probes /json/version directly, no DevToolsActivePort risk
//   #2  Always ensures ≥1 keepalive tab so closing our tab can't kill Chrome
//   #3  Login state is checked first — fail fast if not logged in
//   #4  Auto-prepend an image-generation trigger if the prompt is bare
//   #5  Two-phase wait + fast-fail when ChatGPT shows "已停止思考" with no image

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const POLL_INTERVAL = 5000;
const THINKING_TIMEOUT = 60000;
const RENDER_TIMEOUT = 240000;
const FAST_FAIL_GRACE = 25000;

const TRIGGER_RE = /^\s*(generate|create|draw|paint|make|render|画|生成|绘制|创建)/i;
const isCJK = (s) => /[一-鿿]/.test(s);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchUrl(url, opts = {}) {
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
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve({ status: res.statusCode, body, json: () => JSON.parse(body) });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function cdp(proxy, endpoint, targetId, body) {
  const url = `${proxy}/${endpoint}?target=${targetId}`;
  if (body !== undefined) {
    return fetchUrl(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  return fetchUrl(url);
}

/**
 * Generate an image with ChatGPT Image 2.0.
 *
 * @param {Object}  opts
 * @param {string}  opts.prompt     - Text prompt (auto-prefixed if missing trigger)
 * @param {string}  opts.output     - Output file path (.jpg / .png)
 * @param {string=} opts.edit       - Path to input image for edit mode
 * @param {string=} opts.proxyUrl   - CDP proxy base URL (default: env CDP_PROXY_URL or http://127.0.0.1:3456)
 * @param {boolean=} opts.closeTab  - If true, close ChatGPT tab after gen (default: false → reuse for next call)
 * @param {function=} opts.onProgress - Optional callback({stage, elapsedSec})
 * @returns {Promise<string>} resolved output absolute path
 */
export async function generateImage(opts) {
  const {
    prompt,
    output = "output.png",
    edit,
    proxyUrl = process.env.CDP_PROXY_URL || "http://127.0.0.1:3456",
    closeTab = false,
    onProgress = () => {},
  } = opts;

  if (!prompt) throw new Error("prompt is required");

  // Lesson #4: auto-prepend trigger
  let finalPrompt = prompt;
  if (!TRIGGER_RE.test(prompt)) {
    finalPrompt = isCJK(prompt) ? `画一张图：${prompt}` : `Generate an image: ${prompt}`;
  }

  // Lesson #2: ensure keepalive tab
  const targetsResp = await fetchUrl(`${proxyUrl}/targets`);
  let pageTabs = [];
  try { pageTabs = JSON.parse(targetsResp.body); } catch { pageTabs = []; }
  if (pageTabs.length < 2) {
    await fetchUrl(`${proxyUrl}/new?url=about:blank`);
  }

  // 1. Reuse existing chatgpt.com main-page tab if present (Lesson: speed)
  let targetId;
  const reusable = pageTabs.find(t =>
    t.url === "https://chatgpt.com/" || t.url === "https://chatgpt.com"
  );
  if (reusable) {
    targetId = reusable.targetId;
    onProgress({ stage: "reusing-tab", elapsedSec: 0 });
    // Navigate back to main page → fresh conversation
    await fetchUrl(`${proxyUrl}/navigate?target=${targetId}&url=${encodeURIComponent("https://chatgpt.com/")}`);
    await sleep(1500);
  } else {
    onProgress({ stage: "opening-tab", elapsedSec: 0 });
    const tabResp = await fetchUrl(`${proxyUrl}/new?url=https://chatgpt.com/`);
    const tabData = tabResp.json();
    targetId = tabData.targetId;
    if (!targetId) {
      throw new Error("Failed to create tab — CDP proxy returned no targetId. Is Chrome running with --remote-debugging-port? See troubleshooting in README.");
    }
  }

  // Wait for page load
  await sleep(2500);
  let ready = false;
  for (let i = 0; i < 10; i++) {
    const info = await fetchUrl(`${proxyUrl}/info?target=${targetId}`);
    try {
      const data = JSON.parse(info.body);
      if ((data.ready === "complete" || data.ready === "interactive") &&
          data.url && data.url.includes("chatgpt.com")) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(2000);
  }
  if (!ready) throw new Error("ChatGPT page did not load in time");

  // Lesson #3: login state check
  const loginCheck = await cdp(proxyUrl, "eval", targetId,
    'JSON.stringify({editor: !!document.getElementById("prompt-textarea"), loginBtn: document.querySelectorAll("[data-testid=login-button]").length})'
  );
  let loginState;
  try { loginState = JSON.parse(loginCheck.json().value); }
  catch { throw new Error("Login state probe failed"); }
  if (loginState.loginBtn > 0 || !loginState.editor) {
    throw new Error("ChatGPT not logged in. Run `chatgpt-image-setup` first to log in once (cookie persists in profile).");
  }

  // Close any popup/dialog
  await sleep(500);
  await cdp(proxyUrl, "eval", targetId,
    '(() => { var d = document.querySelector("[role=dialog]"); if (d) { var b = d.querySelector("button"); if (b) { b.click(); return "closed"; } } return "none"; })()'
  );
  await sleep(800);

  // Edit mode: upload image
  if (edit) {
    const absPath = path.resolve(edit);
    if (!fs.existsSync(absPath)) throw new Error(`Edit image not found: ${absPath}`);
    onProgress({ stage: "uploading", elapsedSec: 0 });
    await fetchUrl(`${proxyUrl}/setFiles?target=${targetId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ selector: 'input[type="file"]', files: [absPath.replace(/\\/g, "/")] }),
    });
    await sleep(2500);
  }

  // 4. Inject prompt
  const promptJs = `(() => {
    var e = document.getElementById("prompt-textarea");
    if (!e) return "editor not found";
    e.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, ${JSON.stringify(finalPrompt)});
    return "ok";
  })()`;
  const inject = await cdp(proxyUrl, "eval", targetId, promptJs);
  if (inject.json().value !== "ok") throw new Error("prompt injection failed: " + inject.body);

  // 5. Click send
  await sleep(400);
  await cdp(proxyUrl, "eval", targetId,
    '(() => { var btn = document.querySelector("button[data-testid=\\"send-button\\"]"); if (btn) { btn.click(); return "sent"; } return "no-send-btn"; })()'
  );

  // 6. Phase 1: wait for thinking to finish
  const start = Date.now();
  let thinkDone = false;
  while (Date.now() - start < THINKING_TIMEOUT) {
    await sleep(POLL_INTERVAL);
    const r = await cdp(proxyUrl, "eval", targetId,
      '(() => { var btn = document.querySelector("button[data-testid=\\"stop-button\\"]"); return btn ? "thinking" : "done"; })()'
    );
    if (r.json().value === "done") { thinkDone = true; break; }
    onProgress({ stage: "thinking", elapsedSec: Math.round((Date.now() - start) / 1000) });
  }
  if (!thinkDone) throw new Error("ChatGPT thinking phase timed out");

  // 7. Phase 2: wait for image render with fast-fail (Lesson #5)
  const renderStart = Date.now();
  let imageReady = false;
  let failReason = null;
  while (Date.now() - renderStart < RENDER_TIMEOUT) {
    await sleep(POLL_INTERVAL);
    const probe = await cdp(proxyUrl, "eval", targetId, `(() => {
      var imgs = document.querySelectorAll("img");
      var found = false;
      for (var i = 0; i < imgs.length; i++) {
        if (imgs[i].naturalWidth > 300) { found = true; break; }
      }
      var t = document.body.innerText;
      var stoppedThinking = t.includes("已停止思考") || t.includes("Stopped thinking");
      return JSON.stringify({found: found, stopped: stoppedThinking});
    })()`);
    let pr;
    try { pr = JSON.parse(probe.json().value); } catch { pr = { found: false, stopped: false }; }
    if (pr.found) { imageReady = true; break; }
    if (pr.stopped && Date.now() - renderStart > FAST_FAIL_GRACE) {
      failReason = `ChatGPT printed "已停止思考" with no image — your prompt was likely treated as conversation. Make sure prompt starts with "Generate an image:" / "画一张图：" or similar.`;
      break;
    }
    onProgress({ stage: "rendering", elapsedSec: Math.round((Date.now() - start) / 1000) });
  }

  if (!imageReady) throw new Error(failReason || "Image rendering timed out");

  // 8. Extract image
  await sleep(800);
  const imgResult = await cdp(proxyUrl, "eval", targetId, `(async () => {
    var imgs = document.querySelectorAll("img");
    var best = null;
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].naturalWidth > 300) best = imgs[i];
    }
    if (!best) return JSON.stringify({error: "no-img"});
    var resp = await fetch(best.src);
    var blob = await resp.blob();
    var reader = new FileReader();
    return new Promise(function(resolve) {
      reader.onloadend = function() {
        resolve(JSON.stringify({
          dataUrl: reader.result, size: blob.size, type: blob.type,
          w: best.naturalWidth, h: best.naturalHeight
        }));
      };
      reader.readAsDataURL(blob);
    });
  })()`);

  let imgData;
  try { imgData = JSON.parse(imgResult.json().value); }
  catch { throw new Error("image extraction failed"); }
  if (imgData.error) throw new Error("no image found in DOM");

  // 9. Save (with optional PNG → JPG via Pillow if requested)
  const buf = Buffer.from(imgData.dataUrl.split(",")[1], "base64");
  const outPath = path.resolve(output);
  const outExt = path.extname(outPath).toLowerCase();
  const sourceIsPNG = imgData.type === "image/png";

  if (sourceIsPNG && (outExt === ".jpg" || outExt === ".jpeg")) {
    // Try Pillow conversion; fall back to keeping PNG and renaming
    const tmpPng = outPath + ".tmp.png";
    fs.writeFileSync(tmpPng, buf);
    const { execSync } = await import("node:child_process");
    try {
      execSync(`python -c "from PIL import Image; img=Image.open(r'${tmpPng.replace(/'/g, "\\'")}'); img=img.convert('RGB') if img.mode in ('RGBA','LA','P') else img; img.save(r'${outPath.replace(/'/g, "\\'")}', 'JPEG', quality=95)"`,
        { stdio: "pipe" });
      fs.unlinkSync(tmpPng);
    } catch {
      const fallback = outPath.replace(/\.\w+$/, ".png");
      fs.renameSync(tmpPng, fallback);
      onProgress({ stage: "warn-no-pillow", elapsedSec: 0 });
      return fallback;
    }
  } else {
    fs.writeFileSync(outPath, buf);
  }

  // 10. Either close or navigate back to main page (reuse for next call)
  if (closeTab) {
    await fetchUrl(`${proxyUrl}/close?target=${targetId}`);
  } else {
    await fetchUrl(`${proxyUrl}/navigate?target=${targetId}&url=${encodeURIComponent("https://chatgpt.com/")}`);
  }

  return outPath;
}
