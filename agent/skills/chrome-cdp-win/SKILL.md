---
name: chrome-cdp-win
description: Interact with local Chrome browser session on Windows (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP (Windows)

Lightweight Chrome DevTools Protocol CLI for Windows. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection. Uses Windows named pipes for IPC instead of Unix domain sockets.

## Prerequisites

- Windows OS
- Chrome with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
node scripts/cdp.mjs list
```

### Take a screenshot

```bash
node scripts/cdp.mjs shot <target> [file]    # default: %TEMP%/screenshot.png
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
node scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
node scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
node scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
node scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
node scripts/cdp.mjs net     <target>               # resource timing entries
node scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
node scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
node scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
node scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
node scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
node scripts/cdp.mjs stop    [target]               # stop daemon(s)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `snap --compact` over `html` for page structure.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Chrome shows an "Allow debugging" modal once per tab on first access. A background daemon keeps the session alive so subsequent commands need no further approval. Daemons auto-exit after 20 minutes of inactivity.
- On Windows, daemons use named pipes (`//./pipe/cdp-<targetId>`) instead of Unix sockets. Each daemon writes a marker file at `%TEMP%/cdp-daemon-<targetId>.json` for discovery.
