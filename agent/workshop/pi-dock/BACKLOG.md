# pi-dock — backlog

Everything not yet built. Contracts live in `DESIGN.md`. Delete an item when it ships.

## Release 0.1.0

- [ ] **Final paid smoke** — `node test/smoke.mjs` once (2 real prompts, no retry) after an
      integrated review of the July cleanup (exclusive spawn, budget cap, UTF-8 follow,
      powered-off `set`, name grammar). Never recorded as done.
- [ ] **README** — install, the 8 commands, resident model (stop = power-off, memory kept,
      session resumable from normal Pi), where replies appear (`logs`, `{event:"text"}`),
      model/thinking/budget rules, opaque `--x` + pi-link usage, compact semantics,
      crash/budget/wedge recovery and PID warning, platform honesty (Windows verified,
      Unix inspected only).
      **Required:** headless trust warning — the runner loads `<cwd>/.pi` config and
      extensions without Pi's project-trust prompt; use only in trusted directories.
      Lockfile honesty: `package-lock.json` reproduces this checkout, it does not pin
      consumer transitives.
- [ ] **CHANGELOG** for `0.1.0`.
- [ ] **Package** — version `0.1.0`, author alvivar, MIT, `pi-package` keyword, `files`,
      `bin`, no runtime dep drift; `npm pack --dry-run` and inspect the file list.
- [ ] **Publication copy** → `C:/AERO/me/code/pi-dock/`, compared against the pack list.
      Owner alone runs `npm login` + `npm publish`, then verify `pi-dock@0.1.0`.

## Features — from real usage (RV lab, 2026-08-18)

- [ ] **F1 `send --await [--timeout <s>]`** (high) — block until the `text`/`idle`/`failed`
      that follows *this* prompt and print it. Hand-rolled 3× in the lab; a late reply
      from the previous prompt can be mistaken for the current one.
- [ ] **F2 prompt→reply correlation** (high) — `send` returns `{ok:true, promptId}`; runner
      logs `{event:"prompt", id}` … `{event:"text", replyTo}` / `{event:"idle", after}`.
      Makes pipelines auditable and lets F1 be solved race-free (F1 likely builds on F2).
- [ ] **F3 model discovery** (medium) — `pi-dock models [filter]` and/or
      `model x not found; did you mean: …` (substring match on `provider/id`).
- [ ] **F4 identity columns in `ls`** (medium, cheap) — `model` (+ `budget`, maybe
      thinking/flags); manifest read only, no pipe.
- [ ] **F5 log external input** (medium, security niche) — content entering the session
      not via pipe (e.g. pi-link messages) → `{event:"external", source, from}` without
      body, so the dock log stays the complete lifecycle record.
- [ ] **F6 long prompts** (low) — `send <name> --file <path>` or stdin (`send <name> -`);
      Windows quoting/argv limits.
- [ ] **F7 bulk stop** (low) — `stop --all` or by pattern (`rv-*`).

## Ideas — need design before building

- `reset-to-zero` (programmatic fresh context; the original motivation for pi-dock), `fork`.
- `archive` / `restore` — hide powered-off identities while keeping the mapping; name
  reuse, discoverability, retention and restore semantics undecided.
- Display labels (Unicode) separate from the portable name.
- Project-trust handling for headless runners (beyond the README warning).
- Compact-vs-stop visual ordering: concurrent CLIs may print `compacted` and `stopped` in
  scheduler order; durable state is honest. Only if real usage shows harm — needs new
  protocol semantics.
- Parallel `ls` status probes — unmeasured.

## Rejected

- `rm` / `rm --purge` — orphans identity or destroys memory; `stop` is the safe endpoint.
- `restart` — `stop` + `start` compose.
- Dashboard.
