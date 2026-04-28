#!/usr/bin/env node
// CLI entry: parse args, call driver.generateImage(), report progress.

import { generateImage } from "../lib/driver.mjs";
import { checkPort, DEFAULT_PORT } from "../lib/cdp-proxy.mjs";
import { isChromeAlive } from "../lib/chrome-launcher.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "-p": case "--prompt": args.prompt = next; i++; break;
      case "-o": case "--output": args.output = next; i++; break;
      case "-i": case "--edit": args.edit = next; i++; break;
      case "--proxy": args.proxyUrl = next; i++; break;
      case "--close-tab": args.closeTab = true; break;
      case "-h": case "--help": args.help = true; break;
      case "-v": case "--version": args.version = true; break;
      default: args._.push(a);
    }
  }
  return args;
}

const HELP = `chatgpt-image — generate images via ChatGPT Image 2.0

Usage:
  chatgpt-image -p <prompt> -o <output> [options]

Options:
  -p, --prompt <text>     Text prompt (required). If it doesn't start with a
                          generation verb, "Generate an image: " is auto-prepended.
  -o, --output <file>     Output path (default: output.png)
  -i, --edit <file>       Input image for edit mode
      --proxy <url>       CDP proxy URL (default: env CDP_PROXY_URL or http://127.0.0.1:3456)
      --close-tab         Close ChatGPT tab after generation (default: reuse for next call)
  -v, --version           Print version
  -h, --help              Show this help

First-time setup:
  chatgpt-image-setup     Launches Chrome, starts proxy, walks you through login.

Examples:
  chatgpt-image -p "a futuristic cityscape" -o city.jpg
  chatgpt-image -p "画一张16:9封面图：金色标题'AI 2026'" -o cover.jpg
  chatgpt-image -p "Remove background" -i photo.jpg -o clean.jpg
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { console.log(HELP); return; }
  if (args.version) {
    const { readFileSync } = await import("node:fs");
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf-8"));
    console.log(pkg.version);
    return;
  }
  if (!args.prompt) {
    console.error("Error: --prompt is required\n");
    console.error(HELP);
    process.exit(1);
  }

  // Pre-flight checks
  const proxyUrl = args.proxyUrl || process.env.CDP_PROXY_URL || "http://127.0.0.1:3456";
  const proxyPort = new URL(proxyUrl).port || DEFAULT_PORT;

  if (!(await checkPort(proxyPort))) {
    console.error(`[ERR] CDP proxy not running on :${proxyPort}.`);
    console.error("       Run \`chatgpt-image-setup\` in another terminal first.");
    process.exit(1);
  }

  if (!(await isChromeAlive())) {
    console.error("[ERR] Chrome with remote debugging is not running.");
    console.error("       Run \`chatgpt-image-setup\` in another terminal first.");
    process.exit(1);
  }

  // Generate
  const start = Date.now();
  let lastStage = "";
  try {
    const out = await generateImage({
      prompt: args.prompt,
      output: args.output || "output.png",
      edit: args.edit,
      proxyUrl,
      closeTab: !!args.closeTab,
      onProgress: ({ stage, elapsedSec }) => {
        if (stage !== lastStage) {
          console.error(`[${stage}] ${elapsedSec}s`);
          lastStage = stage;
        }
      },
    });
    const totalSec = Math.round((Date.now() - start) / 1000);
    console.log(out);
    console.error(`[done] ${out} (${totalSec}s)`);
  } catch (e) {
    console.error(`[ERR] ${e.message}`);
    process.exit(1);
  }
}

main();
