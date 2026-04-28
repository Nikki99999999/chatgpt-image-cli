// Cross-platform Chrome locations and DevToolsActivePort paths.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'

/**
 * Find the Chrome executable across platforms.
 * Returns absolute path or null if not found.
 */
export function findChromeExecutable() {
  const candidates = [];
  if (PLATFORM === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (PLATFORM === "linux") {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium"
    );
  } else if (PLATFORM === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe")
    );
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Default isolated user-data-dir for our debug Chrome instance.
 * Uses a stable name (not PID-based) so cookies/login persist across runs.
 */
export function getDefaultUserDataDir() {
  const base = os.tmpdir();
  return path.join(base, "chatgpt-image-cli-profile");
}
