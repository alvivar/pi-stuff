# pi-sub

Minimal Pi extension that shows the **remaining quota and time until reset** of
the active subscription provider. Only two providers are in scope:

| Pi provider ID | Windows |
| --- | --- |
| `openai-codex` | 5 hours, weekly |
| `opencode-go` | rolling, weekly, monthly |

Status: work in progress. This package is not installed or enabled in Pi yet.
Task 1 of [PLAN.md](PLAN.md) is done: project base, normalized quota types and
the two response parsers. Transport, lifecycle and UI come next.

## Scope

Only usable windows reported by the API are shown. A window the API omits is not
treated as available quota, and a window whose percentage is unusable is dropped
instead of guessed. An unusable reset date leaves the reset unknown while the
percentage is still shown.

Not included: other providers, balances, costs, per-model analytics, endpoint
configuration, `.env` reading, login or credential storage.

## Endpoints

Queried only when the matching provider is active (implemented in a later task):

- Codex: `https://chatgpt.com/backend-api/wham/usage`
- OpenCode Go: `https://opencode.ai/zen/go/v1/usage`

Requests carry the credentials Pi already holds for that provider, plus normal
connection metadata. They never contain prompts, files or session content.

## Development

Requires Node.js >= 22.19.0 (TypeScript runs directly through Node's native type
stripping; there is no build step and no runtime dependency).

```bash
npm ci --ignore-scripts   # dev tooling only; nothing here needs install scripts
npm test                  # node:test suites
npm run typecheck
```

Pi itself is declared as a peer dependency, so npm resolves it into the dev tree
for typechecking against its published types. Nothing from that tree is used at
runtime: Pi loads the extension sources directly and this package declares no
runtime dependencies.

## Credits

Endpoint, authentication and response-shape knowledge was recovered from the
audited MIT-licensed `@bacnh85/pi-sub` 0.1.46; see [LICENSE](LICENSE) for the
attribution notice. The implementation here is written from scratch.

MIT licensed.
