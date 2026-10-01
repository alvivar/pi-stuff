# pi-dock — backlog

Everything not yet built. Contracts live in `DESIGN.md`. Delete an item when it ships.

## Release

- [ ] **README** — install, the 11 commands, resident model (stop = power-off, memory kept),
      where results appear (`send --wait`, `wait`, `logs`), model/thinking rules, opaque
      `--x` + pi-link usage, compact semantics, crash/wedge recovery and PID warning,
      platform honesty (Windows verified, Unix inspected only).
      **Required:** headless trust warning — the runner loads `<cwd>/.pi` config and
      extensions without Pi's project-trust prompt; use only in trusted directories.
      Also: there are no limits; an agent runs until stop or a crash.
      Lockfile honesty: `package-lock.json` reproduces this checkout, it does not pin
      consumer transitives.
- [ ] **CHANGELOG** for `0.2.0`.

## Features

- [ ] **F5 log external input** (audit) — content entering the session not via the pipe
      (e.g. pi-link messages) → `{event:"external", source, from}` without body, so the
      dock log stays the complete lifecycle record.
- [ ] **F7 bulk stop** — `stop --all` or by pattern (`rv-*`).
- [ ] **ls uptime** — time since the current runner booted (latest `spawned`), next to age.
- [ ] **Extension-registered providers** in `models` and spawn/set preflight — today both
      use a bare `ModelRuntime`, so providers registered by extensions are not visible.

## Ideas — need design before building

- `reset-to-zero` (programmatic fresh context; the original motivation for pi-dock), `fork`.
