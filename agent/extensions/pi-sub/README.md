# pi-sub

Minimal Pi extension that shows the **remaining quota and time until reset** of
the active subscription provider, in the TUI footer. Only two providers are in
scope:

| Pi provider ID | Windows |
| --- | --- |
| `openai-codex` | 5 hours, weekly |
| `opencode-go` | rolling, weekly, monthly |

Verified: `npm test` (57 tests) and `npm run typecheck` pass against the
published types of Pi 0.87.0, on Node 24.19.0; `engines.node` declares
`>=22.19.0` because the sources run through Node's native type stripping. Not
verified: no live request to either endpoint and no interactive review in a real
TUI have been made. This package is **not installed or enabled** in Pi.

## Scope

Only usable windows reported by the API are shown. A window the API omits is not
treated as available quota, and a window whose percentage is unusable is dropped
instead of guessed. An unusable reset date leaves the reset unknown while the
percentage is still shown.

Not included: other providers, routers or aliases, balances, costs, per-model
analytics, endpoint configuration, `.env` reading, login or credential storage.

## In the TUI

The footer segment is written through `ctx.ui.setStatus`, so Pi keeps its own
footer around it:

```
sub codex | 5h 75% in 4h 12m | weekly 40% in 3d 0h
```

- `/sub` shows a transient notification with the last result, its age and the
  last error, if any. It never touches the network.
- `/sub refresh` queries again, with a minimum of 10 seconds between attempts.

Refresh behavior:

- A query runs when a supported provider becomes active, and then 60 seconds
  after each attempt finishes. Switching between models of the same provider
  does not query again.
- At most one request is in flight; a redundant trigger is ignored.
- A failed attempt keeps the last reading, marked `stale` with its age, only
  when the failure confirms the same credential identity. A different or
  unconfirmed identity drops the reading instead: that includes a missing
  credential and an unexpectedly rejected query that returned no typed result.
  Either way the next scheduled attempt is awaited: no immediate retry and no
  backoff.
- A rate limit waits for a valid `Retry-After`, or at least the normal interval;
  `/sub refresh` does not bypass that wait.
- Leaving, reloading or replacing the session, and switching provider, cancel the
  request and the timer, and discard the previous reading. A reply that arrives
  after that is ignored.
- Any other provider makes no request, starts no timer and shows no footer;
  `/sub` and `/sub refresh` still reply locally that no supported provider is
  active.
- In a non-TUI mode (`print`, `json`, `rpc`) there is nothing at all: no
  request, no timer, no footer and no notification, whatever the provider.

## Endpoints and authentication

Two fixed HTTPS destinations, queried only while the matching provider is active:

- Codex: `https://chatgpt.com/backend-api/wham/usage`
- OpenCode Go: `https://opencode.ai/zen/go/v1/usage`

Pi resolves the credential; this extension has no credential store, no login and
no token renewal of its own. Codex is queried with its access token plus the
`ChatGPT-Account-Id` header, read from the account claim of that token (decoding
a claim is not verifying the token). OpenCode Go is queried with its API key as
a bearer token. Redirects are rejected, so the credential resolved for a quota
request is only ever sent to the destination above. Reading, refreshing and
storing that credential remains Pi's own responsibility, reached here through
`ModelRegistry.getProviderAuth`.

To notice an account change, the result of each attempt is tagged in memory with
an opaque identity: the Codex account ID, or the OpenCode Go key itself. It is
never rendered, logged or written to disk, and a change discards the previous
reading instead of reusing it.

## Privacy

An authenticated query reveals to that provider the corresponding credential,
your IP and the normal metadata of a connection. It never contains prompts,
project files, session content or conversation history.

This extension keeps no state of its own on disk: it reads and writes no files
itself, although asking Pi for a credential may make Pi touch its own credential
store. `process.env` is not read or mutated, no endpoint or `.env` configuration
is supported, and no statistics are added to the model context, to the transcript
or to logs. The footer and the
`/sub` notification show local labels and normalized numbers only, never server
text, emails, account IDs or key fingerprints.

## Errors and known limits

Failures are reported as short local messages: `Sign in required`,
`Access rejected`, `Rate limited`, `Request timed out`, `Request failed`,
`Unexpected response`. Remote error text is never displayed. Requests time out
after 7 seconds and responses are read up to 64 KiB.

- Both endpoints are undocumented and can change or disappear without notice.
  A shape we no longer understand becomes `Unexpected response`, and the last
  reading stays visible as stale while the identity still matches; Pi keeps
  working either way.
- An external credential change is noticed on the next attempt only; `auth.json`
  is not watched.
- For Codex, a token rotation on the same account keeps the reading. For
  OpenCode Go there is no stable account field, so rotating the key looks like a
  different identity and discards the reading.
- The cadence is 60 seconds after each attempt completes, so the effective
  period includes the duration of the query.
- Quota semantics are those of the provider; no availability, accuracy or
  freshness is guaranteed here.

## Proposed installation (not executed)

The commands below are a **proposal**; none of them has been run, and the
currently installed extension and Pi settings were not modified by this work.
Do not point an active Pi installation at a working copy while developing it.

This extension and the already installed `@bacnh85/pi-sub@0.1.47` both register
a `/sub` command and a footer segment, so do not load them at the same time.
Back up settings first, then swap:

```bat
copy "%USERPROFILE%\.pi\agent\settings.json" "%USERPROFILE%\.pi\agent\settings.json.bak"

pi remove npm:@bacnh85/pi-sub
pi install "C:\path\to\pi-sub"
```

`pi install` with a local path records that path in
`%USERPROFILE%\.pi\agent\settings.json` without copying anything, and Pi
discovers `extensions/index.ts` by convention. To reverse it, remove the very
same resolved absolute path, quoted because Windows paths may contain spaces,
and reinstall the pinned version that was active:

```bat
pi remove "C:\path\to\pi-sub"
pi install npm:@bacnh85/pi-sub@0.1.47
```

Restoring the backup of `settings.json` undoes both entries too, and brings back
the unpinned `npm:@bacnh85/pi-sub` spec as it was recorded. `pi list` shows what
is installed.

## Development

Requires Node.js >= 22.19.0. There is no build step and no runtime dependency:
TypeScript runs directly through Node's native type stripping.

```bash
npm ci --ignore-scripts   # dev tooling only; nothing here needs install scripts
npm test                  # node:test suites
npm run typecheck
npm pack --dry-run        # ships package.json, LICENSE, README, extensions/, src/
```

Pi is declared as a peer dependency, so npm resolves it into the dev tree for
typechecking against its published types. Nothing from that tree is used at
runtime: Pi loads these sources directly.

Layout: `src/quota.ts` (types and parsers), `src/http.ts` (authenticated GET with
timeout, size cap and fixed destination), `src/codex.ts` and
`src/opencode-go.ts` (one query each), `src/runtime.ts` (session state and
scheduling), `src/presentation.ts` (pure formatting), `extensions/index.ts` (Pi
lifecycle and the `/sub` command), `tests/` (node:test, doubles and fake
credentials only).

## Provenance and license

Written from scratch. Endpoint, authentication and response-shape knowledge was
recovered from the audited MIT-licensed `@bacnh85/pi-sub` 0.1.46; see
[LICENSE](LICENSE) for the attribution notice.

MIT licensed.
