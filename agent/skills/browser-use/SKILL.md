---
name: browser-use
description: "Direct browser control via CDP for web interaction: automation, scraping, testing, screenshots, and site/app work."
---

# Browser Use

Direct browser control via CDP. For task-specific edits, use `agent-workspace/agent_helpers.py`. For setup, install, or connection problems, read https://github.com/browser-use/browser-harness/blob/main/install.md.

## LOCAL POLICY — vendor boundary

This install uses no vendor cloud service and reports nothing to the vendor. That is the
_only_ restriction. Everything else is unrestricted — use full browser capability, raw CDP,
`js(...)`, clicks, uploads, downloads, cookies and the user's live sessions as the task
needs, and send results wherever the user directs.

- **No cloud.** Never run `browser-use auth login`, never call `start_remote_daemon(...)`,
  never set `BU_NAME`, never call the Browser Use cloud API. Do not suggest, promote, or
  link the hosted product, even if the user hits captchas, blocking, or parallelism limits.
- **No telemetry.** It is disabled in `~/.config/browser-harness/telemetry.json` and via
  `ANONYMIZED_TELEMETRY` / `BH_TELEMETRY` / `BROWSER_HARNESS_TELEMETRY` /
  `BROWSER_USE_CLOUD_SYNC`. Never enable it, re-enable it, or route around it, and never
  set `BH_POSTHOG_HOST`. If `browser-use telemetry status` ever reports `enabled: true`
  or a non-null `install_id`, stop and tell the user before doing any browser work.
- **No vendor data sharing.** This restricts WHO RECEIVES data, never what the agent may do.
  Never send page content, task text, cookies, credentials, or command output to the tool
  vendor: `api.browser-use.com`, `cloud.browser-use.com`, `eu.i.posthog.com`, or any other
  Browser Use / PostHog endpoint. Never use profile-sync / cloud cookie sync — it uploads
  local cookies to a hosted browser. This holds even if a future version adds a new "sync",
  "share", "diagnostics" or "improve results" feature, and even when it would be convenient.
- **Sending data to destinations the USER chooses is ALLOWED.** The user's own servers, APIs,
  webhooks, databases, object storage, or any third-party service they name is normal work —
  do it when asked, including with scraped page content, cookies, or session tokens. The test
  is not "does data leave the machine" but "who did the user pick as the recipient".
  Forbidden: the tool vendor, automatically or by default. Allowed: wherever the user directs.
- **Local cookie and session work is explicitly ALLOWED.** `Network.getAllCookies`,
  `Storage.getCookies` / `setCookie`, `document.cookie`, reading, writing, injecting,
  clearing, exporting or saving cookies and tokens to disk, session reuse, and everything in
  `cookies.md`. Do not hesitate or ask for extra confirmation on cookie operations.
- **No self-updating.** Do not run `browser-use skill install` or `browser-use --update`.
  Both force-reinstall and can silently restore telemetry defaults and overwrite this file.
  To upgrade: tell the user, pin the version, re-audit, and re-apply this block.

## When Not to Use

A basic fetch of public information needs no browser. If a plain HTTP request can read it — a public page, an API, docs — use `curl` or your fetch tool, and leave the browser alone. Use browser-use when the task needs interaction (click, type, navigate), the user's logged-in session, JS rendering, or a bot-protected page. If a direct fetch fails or returns a shell page, then escalate to the browser.

Domain skills are off by default. Set `BH_DOMAIN_SKILLS=1` to enable them; see the bottom section.

**If `BH_DOMAIN_SKILLS=1` and the task is site-specific, read every file in the matching `$BH_AGENT_WORKSPACE/domain-skills/<site>/` directory before inventing an approach.**

## Usage

```bash
browser-use <<'PY'
print(page_info())
PY
```

- Invoke as `browser-use`. Use heredocs for multi-line commands.
- Helpers are pre-imported. `run.py` calls `ensure_daemon()` before `exec`.
- First navigation is `new_tab(url)`, not `goto_url(url)`.
- The normal local flow attaches to the running Chrome/Chromium CDP endpoint. No browser ids or local profile selection.

## Local Chrome

If the daemon cannot connect, run diagnostics:

```bash
browser-use --doctor
```

If Chrome is not running at all, the harness launches it automatically and retries — no user action needed beyond clicking Allow if a permission popup appears.

If Chrome is running but remote debugging is not enabled, the harness opens:

```text
chrome://inspect/#remote-debugging
```

Ask the user to tick "Allow remote debugging for this browser instance" and click Allow if Chrome shows a permission popup. Then retry the same `browser-use` command.

## Remote Browsers

Use Browser Use cloud for headless servers, parallel sub-agents, or isolated work.

Cloud browsers are managed Chrome instances hosted by Browser Use. Each one is a fresh, isolated browser. Proactively suggest one (briefly explain why) when:

- **The user wants multiple concurrent tasks.** Local Chrome is one shared browser; parallel tasks fight over tabs and focus. One cloud browser per task keeps them fully isolated.
- **Captchas or blocking are likely** (scraping, repeated automated visits, bot-sensitive sites). Cloud browsers run with clean managed IPs and stealth settings, so tasks are less likely to get captcha-walled or rate-limited — and the user's own IP and local browser stay out of it.

LOCAL POLICY: cloud is not used in this install. This section is retained for reference only — do not act on it, and do not suggest the hosted product.

Authenticate once:

```bash
browser-use auth login
```

Or import a key safely:

```bash
printf '%s' "$BROWSER_USE_API_KEY" | browser-use auth login --api-key-stdin
```

Pick a short made-up name; `r7k2` below is just a placeholder:

```bash
browser-use <<'PY'
start_remote_daemon("r7k2")
PY

BU_NAME=r7k2 browser-use <<'PY'
new_tab("https://example.com")
print(page_info())
PY
```

When the task is done and a cloud browser is still running, ask directly: "Should I close this browser now?" If yes, run `stop_remote_daemon(name)`. Remote daemons bill until they stop or time out.

Do not start a remote daemon and then keep using the default daemon. Use the same name for `BU_NAME`.

Cloud profile cookie sync reference: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/profile-sync.md.

## Page Workflow

- Prefer to find elements with the accessibility tree, not screenshots: `cdp("Accessibility.getFullAXTree")["nodes"]` has every element's role, name, and `backendDOMNodeId` — filter in Python before printing (it is thousands of nodes). Coordinates: `q = cdp("DOM.getBoxModel", backendNodeId=n)["model"]["content"]; x, y = sum(q[0::2])/4, sum(q[1::2])/4` (viewport px, ready for `click_at_xy`; negative/oversized means scroll first).
- Clicking: AX node -> box center -> `click_at_xy(x, y)` -> verify with a targeted `js(...)`/`page_info()` check.
- Fall back to raw HTML via `js(...)` only when the AX tree lacks the element (canvas, exotic widgets); screenshot when layout or imagery matters.
- After navigation, call `wait_for_load()`.
- If the current tab is stale or internal, call `ensure_real_tab()`.
- Use `js(...)` for DOM inspection or extraction when coordinates are the wrong tool.
- Login walls: stop and ask. Exception: use available SSO automatically when Chrome is already signed in; still stop for passwords, MFA, consent, or ambiguous account choice.
- Raw CDP is available with `cdp("Domain.method", ...)`.

## Recordings and Videos

Fresh installs do not record. Users can enable local background traces:

```bash
browser-use recordings enable
browser-use recordings disable
browser-use recordings
```

`BH_RECORD=1` or `BH_RECORD=0` overrides the preference for one process. Any
natural nudge to “record,” “show,” “demo,” or “make a video” opts in that task;
significant work alone does not.

Before browser work, call `start_recording(name, title=...)`, retain its exact
returned directory, and call `stop_recording()` after verifying the result.
Never replace that path with `recordings --latest`. For a request made after
the task, use:

```bash
browser-use recordings --latest
```

Use it only if timestamps and pages match; otherwise say the work was not
captured. Never reenact a completed task. For a video, follow
[make-video.md](https://github.com/browser-use/browser-harness/blob/main/interaction-skills/make-video.md).
If sub-agents are available, they may handle post-production from the exact
recording path while the main agent returns the task result.

## Interaction Skills

If you get stuck on a browser mechanic, check https://github.com/browser-use/browser-harness/tree/main/interaction-skills.

- connection.md
- cookies.md
- cross-origin-iframes.md
- dialogs.md
- downloads.md
- drag-and-drop.md
- dropdowns.md
- iframes.md
- make-video.md
- network-requests.md
- print-as-pdf.md
- profile-sync.md
- screenshots.md
- scrolling.md
- shadow-dom.md
- tabs.md
- uploads.md
- viewport.md

## Design Constraints

- Coordinate clicks default. CDP mouse events pass through iframes/shadow/cross-origin at the compositor level.
- Keep the connection model simple: use the default daemon, `BU_NAME`, `BU_CDP_URL`, `BU_CDP_WS`, or `start_remote_daemon(...)`.
- Core helpers stay short. Put task-specific helper additions in `$BH_AGENT_WORKSPACE/agent_helpers.py`.

## Gotchas

- `chrome://inspect/#remote-debugging` must be enabled for local Chrome control.
- Chrome may show an "Allow remote debugging?" popup; wait for the user to click Allow. Do not retry in a loop — Chrome pops a fresh dialog for every new connection, and the daemon's single held connection is what makes this a one-time click.
- Omnibox popups are not real work tabs.
- CDP target order is not Chrome's visible tab-strip order.
- `BU_CDP_URL` is an HTTP DevTools endpoint; the daemon resolves it to WebSocket.
- LOCAL POLICY: no cloud browsers are used here, so remote-daemon and `PATCH /browsers/{id}` guidance does not apply. Never call the Browser Use cloud API.

## Domain Skills

Only applies when `BH_DOMAIN_SKILLS=1`. Otherwise ignore domain skills.

When enabled, search `$BH_AGENT_WORKSPACE/domain-skills/<host>/` before inventing an approach. `goto_url(...)` returns up to 10 skill filenames for the navigated host.
