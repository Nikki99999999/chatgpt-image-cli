# chatgpt-image-cli

> Generate images with **ChatGPT Image 2.0** from your terminal — using your existing **ChatGPT Plus/Max** membership. No API key needed.

```bash
chatgpt-image -p "Generate an image: a futuristic cityscape at night" -o city.jpg
```

## Why this exists

OpenAI's `gpt-image-1` API is paid per call. But ChatGPT Plus/Max members already have unlimited (rate-limited) image generation in the web UI. This CLI drives that web UI through Chrome remote-debugging so you can:

- Generate images from terminal / scripts / CI
- Use the **best Chinese text rendering** of any current image model (GPT-Image-2's killer feature)
- Pay zero extra (your existing membership covers it)

## Features

- 🚀 **Zero-config first run**: `chatgpt-image-setup` launches Chrome, starts proxy, walks you through login
- 🔁 **Tab reuse**: subsequent calls reuse the same ChatGPT tab (saves ~10s/image)
- 🌍 **Cross-platform**: macOS / Linux / Windows
- 🧠 **Smart fail-fast**: detects "已停止思考 / Stopped thinking" and bails immediately instead of wasting 4 minutes
- 🇨🇳 **Auto Chinese support**: detects CJK prompts, prepends `画一张图：` automatically
- 🎒 **Zero npm deps**: pure Node 22+ with native WebSocket
- 🛡️ **Isolated profile**: uses a dedicated user-data-dir, never touches your daily Chrome

## Requirements

- **Node.js ≥ 22** (uses native WebSocket)
- **Google Chrome** installed (any recent version)
- **ChatGPT Plus or Max** membership
- (Optional) **Python + Pillow** for PNG → JPG conversion

## Install

```bash
# Option 1: install globally
npm install -g chatgpt-image-cli

# Option 2: clone and link
git clone https://github.com/Nikki99999999/chatgpt-image-cli.git
cd chatgpt-image-cli
npm link
```

## Quick Start

### 1. First-time setup (once)

```bash
chatgpt-image-setup
```

This:
- Launches a dedicated Chrome with remote debugging enabled (`~/tmp/chatgpt-image-cli-profile`)
- Starts the CDP proxy on `127.0.0.1:3456`
- Opens chatgpt.com in that Chrome and waits for you to log in
- Once logged in, your cookies persist — no need to log in again next time

**Keep this terminal alive** — it hosts the proxy. Press Ctrl+C to stop.

### 2. Generate an image (from any other terminal)

```bash
chatgpt-image -p "Generate an image: a futuristic cityscape at night" -o city.jpg
```

Output:
```
[reusing-tab] 0s
[thinking] 5s
[thinking] 10s
[rendering] 35s
[rendering] 65s
city.jpg
[done] /Users/you/city.jpg (87s)
```

### 3. Batch generation

```bash
for prompt in "a red rose" "blue ocean" "yellow sunflower"; do
  chatgpt-image -p "$prompt" -o "${prompt// /_}.jpg"
done
```

(With tab reuse, each subsequent call saves ~10 seconds vs. opening a fresh tab.)

## CLI Reference

```
chatgpt-image -p <prompt> -o <output> [options]

Options:
  -p, --prompt <text>   Text prompt (required)
  -o, --output <file>   Output path (default: output.png)
  -i, --edit <file>     Input image for edit mode
      --proxy <url>     CDP proxy URL (default: http://127.0.0.1:3456)
      --close-tab       Close ChatGPT tab after generation (default: reuse)
  -v, --version
  -h, --help
```

## Programmatic API

```js
import { generateImage } from "chatgpt-image-cli";

const path = await generateImage({
  prompt: "a futuristic cityscape",
  output: "city.jpg",
  onProgress: ({ stage, elapsedSec }) => console.log(stage, elapsedSec),
});
```

## How it works

```
Your CLI ─→ CDP Proxy (127.0.0.1:3456) ─→ Chrome (127.0.0.1:9222) ─→ chatgpt.com
                            ↑
        single Node process,
        no npm dependencies,
        speaks Chrome DevTools Protocol
```

1. CLI sends a tiny HTTP request to the local CDP proxy.
2. Proxy translates it into CDP commands over WebSocket to Chrome.
3. Chrome navigates to chatgpt.com (your dedicated profile, already logged in).
4. Proxy injects your prompt into the chat editor, clicks send.
5. Two-phase polling: wait for "thinking" indicator to disappear, then for `<img>` to render.
6. Image fetched as base64 inside the page, returned via the proxy, saved to disk.
7. Tab is **navigated back to chatgpt.com/** (not closed) so the next call reuses it.

## Pitfalls (and what we already handle)

These were learned the hard way during dogfooding:

| Pitfall | What we do |
|---------|-----------|
| Chrome's `DevToolsActivePort` cache lies after restart | We probe `/json/version` directly every connect |
| Chrome auto-exits when last tab closes (Windows) | We always keep ≥1 keepalive about:blank tab |
| Bare descriptive prompts get treated as conversation, not generation | Auto-prepend "Generate an image: " / "画一张图：" |
| ChatGPT shows "已停止思考" with no image (refused/silent fail) | Fast-fail after 25s grace, don't wait full 4 minutes |
| Login state lost after Chrome restart | We use a stable user-data-dir so cookies persist |

## Troubleshooting

### `Error: CDP proxy not running on :3456`

Run `chatgpt-image-setup` in another terminal first and leave it running.

### `Error: ChatGPT not logged in`

Run `chatgpt-image-setup` again — it will detect the missing login and walk you through it.

### `Error: Chrome executable not found`

Set `CHROME_PATH=/path/to/chrome` env var, or install Chrome from https://www.google.com/chrome/.

### Generated image has weird colors or is mangled

The `output.jpg` path triggers PNG→JPG conversion via Python + Pillow. If Pillow isn't installed, we fall back to saving as `.png` and warn you. Either install Pillow (`pip install Pillow`) or use `.png` in `-o`.

### "Rate limited" or repeated failures

ChatGPT may throttle if you generate too many images in quick succession. Add a `sleep 10` between batch calls.

### Chinese text shows up garbled in the generated image

This is rare but happens — try shortening the prompt or moving the Chinese text into quotes:
```bash
# Less reliable
chatgpt-image -p "draw a cover saying 跨越规模化试水期"
# More reliable
chatgpt-image -p "画一张16:9封面图：标题文字'跨越规模化试水期'，金色字体"
```

## Known limitations

- Output resolution is decided by ChatGPT (typically 1024×1024 or 1792×1024); not configurable.
- Editing mode supports one input image at a time.
- Headless mode is not supported — Chrome must be a real desktop instance because ChatGPT actively blocks headless.
- DOM selectors (`data-testid="send-button"` etc.) may break if ChatGPT redesigns its UI; submit an issue if so.

## Environment Variables

| Var | Default | Use |
|-----|---------|-----|
| `CHROME_PATH` | (auto-detect) | Override Chrome executable path |
| `CHROME_DEBUG_PORT` | `9222` | Chrome remote-debugging port |
| `CDP_PROXY_PORT` | `3456` | Local proxy port |
| `CDP_PROXY_URL` | `http://127.0.0.1:3456` | Proxy URL for the CLI client |

## License

MIT — see [LICENSE](LICENSE).

## Credits

Built and battle-tested while generating a tutorial deck end-to-end. The full failure-mode catalogue is included as code comments and the **Pitfalls** table above.

This project is **not affiliated with OpenAI / Anthropic**. It uses ChatGPT's web interface through Chrome's standard remote debugging protocol — the same way DevTools or any debugger talks to the browser. You are responsible for complying with OpenAI's [Terms of Service](https://openai.com/policies/terms-of-use/).
