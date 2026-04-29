# Loading API Credentials into Pi

Pi resolves credentials in this order: `--api-key` flag → `auth.json` → environment variable → `models.json`.

## Options

| # | Method | Description | Notes |
|---|--------|-------------|-------|
| 1 | **CLI flag** | `pi --api-key <key>` | Visible in shell history and process list. Not recommended. |
| 2 | **Environment variable** | e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Standard, but visible to the same user via `/proc`. |
| 3 | **`auth.json` — literal** | `{ "anthropic": { "type": "api_key", "key": "sk-..." } }` | File at `~/.pi/agent/auth.json`, created with `0600` perms. |
| 4 | **`auth.json` — env var reference** | `{ "key": "MY_ANTHROPIC_KEY" }` | Pi reads the named env var at runtime. Pairs well with systemd `EnvironmentFile=`. |
| 5 | **`auth.json` — shell command** | `{ "key": "!<command>" }` | Executes command, uses stdout. Cached for process lifetime. Integrates with secret managers. |
| 6 | **OAuth via `/login`** | Interactive subscription login | For Claude, ChatGPT, Copilot, Gemini, Antigravity. Tokens auto-refresh. |
| 7 | **Cloud workload identity** | IAM roles, ADC, etc. | No secret stored on disk. |

## Secret Manager Integration (Option 5 examples)

```json
{ "key": "!op read 'op://vault/anthropic/key'" }                              // 1Password
{ "key": "!vault kv get -field=key secret/anthropic" }                        // HashiCorp Vault
{ "key": "!aws secretsmanager get-secret-value --secret-id anthropic --query SecretString --output text" }
{ "key": "!security find-generic-password -ws anthropic" }                    // macOS Keychain
```

## Cloud Provider Identity (Option 7)

- **AWS Bedrock**: `AWS_PROFILE`, IAM keys, bearer token, ECS task roles, or IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE`)
- **Google Vertex AI**: Application Default Credentials (`gcloud auth application-default login`) or `GOOGLE_APPLICATION_CREDENTIALS` service account file
- **Azure OpenAI**: `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`

## Recommendation for Servers

1. **Cloud workload identity** where available (IRSA, ECS task roles, GCP ADC) — no secrets at rest.
2. **`auth.json` with `"!<command>"`** sourcing from a secret manager.
3. **Env var reference** in `auth.json` + systemd `EnvironmentFile` (mode `0600`).
4. Avoid the `--api-key` flag and shell-profile `export` on multi-user hosts.

Reference: `pi-coding-agent/docs/providers.md`
