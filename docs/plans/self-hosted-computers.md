# Plan: self-hosted bot computers (Proxmox / Linux box over Tailscale)

Status: research + implementation plan. Not a feature doc. Delete or move when the work lands.

## Verdict

1. **Kasm is the wrong seam.** Kasm's Developer API cannot back `SandboxProvider`:
   - `POST /api/public/exec_command_kasm` is fire-and-forget. The response is the kasm object and a timestamp, no stdout, stderr, or exit code. Every Rakazo desktop operation (display allocation, `xdotool`, screenshots, `PREPARE_LINUX_DESKTOP`, background-work inspection) goes through `LinuxDesktopHost.run()` and needs stdout + exit code.
   - No file API. `listFiles`, `readFile`, `writeFile`, `exportWorkspace`, `importWorkspace` would have no transport.
   - No pause/resume in the API (keepalive, destroy only). `stop()` would have to destroy, which loses the running session; persistence would depend on Kasm persistent profiles, a different durability contract than the portable workspace.
   - The screen is Kasm's own KasmVNC UI behind Kasm's JWT (`/#/connect/kasm/<id>/<user>/<token>`), not Rakazo's per-display token-protected noVNC gateway. View/control leases, the terminal, and the screen proxy reporter would all need Kasm-specific rewrites.
   - A workable Kasm adapter would mean building a custom Kasm image that embeds Rakazo's computer control service and reaching the container over the network from the API, which is CreateOS-sized work (~1.8k lines + tests) to end up with a worse version of what the Docker supervisor already does.

2. **Rakazo already has the self-hosted provider you want: `SANDBOX_PROVIDER=docker`.** The in-stack sandbox supervisor (`infra/sandboxes/supervisor`) creates `rakazo/computer` containers via the Docker socket, serves exec/files/observe/actions/screen/terminal over HTTP with a bearer token, and the API talks to it only over `SANDBOX_SUPERVISOR_URL`. Run that supervisor on the Proxmox VM, reach it over Tailscale, and E2B is replaced with zero new provider code. Three gaps block this today (below). Closing them is the work.

Recommendation: do option 2. Do not build a Kasm adapter. Keep the Kasm web UI for humans if you like it; it is unrelated to bot computers.

## What breaks when the supervisor is on another machine

| # | Gap | Where | Fix |
| --- | --- | --- | --- |
| A | API and supervisor assume a shared data directory. `restoreComputerWorkspace` / `checkpointComputerWorkspace` short-circuit for `kind === "docker"` with `LocalAgentHomeStore` and only bump a revision marker; the supervisor mounts the bot home from *its* `DATA_DIR`. Remote supervisor means the API-side home store is empty and thread files / checkpoints silently diverge. | `packages/adapters/src/computer-workspace.ts:85,312`, `infra/sandboxes/supervisor/src/computer-spec.ts` (`computerHomeStorage`) | New env `SANDBOX_SUPERVISOR_HOME=shared\|remote` (default `shared`, the current behavior). `remote` makes docker take the same export/import path as E2B/Boat, using the supervisor's existing `GET/POST /computers/:id/files`. Resolve once in `sandbox-provider-env.ts`, pass through `SandboxProviderOptions`, surface as a provider capability rather than a kind check so the workspace code stops special-casing `"docker"`. |
| B | Screens. In Compose the web proxy joins each computer's bridge network (`SANDBOX_SCREEN_NETWORK=isolated`). Remote: nothing on the API host can reach the container IP. | `infra/sandboxes/supervisor/src/computer-spec.ts` (`resolveScreenPublishTarget`, `SCREEN_HOST`, `screenUrlFor`) | Use the existing `published` mode with `SANDBOX_SCREEN_HOST=<supervisor tailscale IP>` and bind published screen ports to that interface only (not `0.0.0.0`). Verify the web screen proxy (`apps/web/vite.config.ts` `resolveNovncTarget`) accepts a non-loopback upstream and that `screenUrlWithToken` still carries the view/control token. Add a supervisor startup check that `SANDBOX_SCREEN_HOST` is set when `SUPERVISOR_HOST` is not loopback. |
| C | Control endpoint publication only supports container IP or `127.0.0.1` (`SANDBOX_CONTROL_VIA_LOOPBACK`). | `computer-spec.ts` (`resolveComputerControlEndpoint`, `publishedLoopbackControlHostPort`) | Confirm the supervisor process itself is the only caller of `/v1/desktop` (it is, per current code). If so, no change: the supervisor is local to its containers. Document that, and add a test that the API never dials a computer directly. |
| D | Trust boundary. "Access to the supervisor is equivalent to control of the Docker host" (Compose comment). Today it is unexposed. | compose, docs | Bind the supervisor to the Tailscale interface only, keep the bearer token, recommend a Tailscale ACL that allows only the API host to port 7091 and the screen port range. Never bind to `0.0.0.0` on a routable NIC. Add a startup refusal when `SUPERVISOR_HOST` is `0.0.0.0` and `SANDBOX_SUPERVISOR_ALLOW_PUBLIC_BIND` is unset. |
| E | Ops packaging. No standalone way to run just the supervisor + computer image on a box. | `infra/` | Standalone Compose file + systemd unit + install script (see PR 2). |

## PR plan

Each PR: branch from `main`, keep migrations none (no schema changes expected), deterministic offline tests, docs updated in the same PR. Author is the maintainer; agents open the PR as the maintainer and follow `.agents/skills/pr-watch/SKILL.md` until review bots finish.

### PR 1 (Opus): remote-supervisor support in the docker provider

Scope: gaps A, B, C, D. No new provider kind. No UI copy.

1. `packages/adapters/src/sandbox-provider-env.ts`: parse `SANDBOX_SUPERVISOR_HOME` (`shared` | `remote`, default `shared`; anything else throws at boot). Add `supervisorHome` to `SandboxProviderOptions` and thread it into `DockerSandboxProvider`.
2. `DockerSandboxProvider.describe()`: add capability `sharedHome: boolean` (true when `shared`). Extend `SandboxCapabilities` in `packages/adapter-kit/src/interfaces.ts` with the optional flag. Check `rg "capabilities: \{"` for other `describe()` implementations and leave them untouched (optional field).
3. `packages/adapters/src/computer-workspace.ts`: replace the two `computer.kind === "docker" && home instanceof LocalAgentHomeStore` checks with `sandbox.describe().capabilities.sharedHome && home instanceof LocalAgentHomeStore`. Review the third check at ~line 333 (team checkpoint lease logic): keep the docker exception only if it is about lease semantics, not disk sharing; comment why.
4. Supervisor (`infra/sandboxes/supervisor/src/index.ts`, `computer-spec.ts`):
   - When `SANDBOX_SCREEN_NETWORK=published`, bind published screen ports to `SANDBOX_SCREEN_HOST` (HostIp in port bindings), not the Docker default. Reuse-matching (`controlPortPublicationMatches`-style) must compare HostIp too so old containers get recreated.
   - Startup refusal: `SUPERVISOR_HOST` non-loopback and `SANDBOX_SCREEN_HOST` unset or loopback → exit with a one-line error naming both variables.
   - Startup refusal: `SUPERVISOR_HOST=0.0.0.0` unless `SANDBOX_SUPERVISOR_ALLOW_PUBLIC_BIND=true`. Compose sets it today; set the flag in the Compose files so nothing regresses.
   - `/health` (or the existing internal health) reports `screenHost` and `homeMode` so `curl` from the API host proves the wiring.
5. Web screen proxy: confirm `resolveNovncTarget` + upstream connect work with a non-loopback host from the API-issued target. Add a unit test with a `100.x.y.z` host if the target parser has one.
6. Tests (vitest, offline):
   - `sandbox-provider-env.test.ts`: default, `remote`, invalid value.
   - `computer-workspace.test.ts`: with `sharedHome=false` the docker kind goes through export/import; with `true` it still short-circuits.
   - supervisor `computer-spec.test.ts`: port binding HostIp for published mode; startup refusals.
7. Docs: `docs/self-host-sandbox-providers.md` new section "Docker supervisor on another machine" (env table, Tailscale note, security note). `.env.example`: the two new variables, commented out.

PR description: Why = bot computers can run on a self-owned Linux host instead of a hosted sandbox vendor, which the Docker provider nearly supported but assumed the API and supervisor share a disk and a Docker network. What = the gap table. How tested = the unit tests above in words, plus a manual run with the API on one machine and the supervisor on another over Tailscale (describe, no hostnames or IPs).

### PR 2 (Sonnet): standalone supervisor deployment

Scope: gap E. Infra and docs only.

1. `infra/compose/docker-compose.supervisor.yml`: supervisor service only (same image and env block as `docker-compose.images.yml`'s `supervisor`, plus `SUPERVISOR_HOST=<tailscale ip>` via `${SANDBOX_SUPERVISOR_BIND:?...}`, `SANDBOX_SCREEN_NETWORK=published`, `SANDBOX_SCREEN_HOST`, `SANDBOX_SUPERVISOR_HOME=remote` is an API-side variable so document it there, not here). Named volume for `/data`. Pulls the computer image on first start.
2. `infra/compose/install-supervisor.sh`: checks Docker Engine, Tailscale up, writes `.env.supervisor` from prompts (token generated with `openssl rand -hex 32`), `docker compose up -d`, prints the `SANDBOX_SUPERVISOR_URL` and `SANDBOX_SCREEN_HOST` lines to paste into the API host's `.env`. Reuse `check-host.sh` pieces where they apply.
3. `infra/systemd/rakazo-supervisor.service` (optional, Compose `restart: unless-stopped` already covers reboots; include only if `install-images.sh` convention does).
4. Smoke test in `infra/compose/*.smoke.sh` style: compose config renders, required vars fail closed.
5. Docs: `docs/self-host.md` short pointer; the full guide lives in the PR 1 section. Proxmox note: use a VM (not LXC) or an LXC with nesting + keyctl enabled; the computer egress rules (`restrict-computer-egress.sh`) run on that VM.

### PR 3 (Sonnet, only if PR 1 surfaces it): UI label

`apps/web/src/lib/computer-sandbox.ts` classifies `docker` as local. If the settings screen shows "Docker" with local-only guidance, add nothing unless the guidance is wrong for a remote supervisor. No new copy without a reason.

## Operator runbook (target state after PR 1 + 2)

On the Proxmox VM (Debian/Ubuntu, Docker Engine, Tailscale):

```
git clone <repo> && cd rakazo/infra/compose
bash install-supervisor.sh      # prompts; prints the two lines below
```

On the API host `.env`:

```
SANDBOX_PROVIDER=docker
SANDBOX_SUPERVISOR_URL=http://<supervisor-tailscale-ip>:7091
SANDBOX_SUPERVISOR_TOKEN=<same token>
SANDBOX_SUPERVISOR_HOME=remote
```

Verify: `curl -fsS http://127.0.0.1:3100/internal/health` on the API host shows `sandbox: docker`; a bot run opens a screen.

## Kasm, if someone insists later

Minimum viable design, recorded so nobody re-researches it:

- Lifecycle via Kasm API: `request_kasm` (custom image), poll `get_kasm_status` until `running`, `keepalive` on a timer, `destroy_kasm`. API key needs `User` + `Users Auth Session` + `Images View`.
- Command/file/desktop transport: a custom Kasm workspace image built FROM `rakazo/computer` with the control service (`/v1/desktop`) started by Kasm's exec `first_launch` hook; the adapter talks to it over a Tailscale subnet route to the Kasm docker network. Kasm's exec API is only used to start that service.
- Screen: either Kasm's `kasm_url` (loses Rakazo lease semantics; takeover would be "whoever has the link") or Rakazo's gateway ports published through the same subnet route.
- Persistence: Kasm persistent profiles on `/home/kasm-user`, with Rakazo export/import for checkpoints.

Estimate: comparable to `createos-sandbox.ts` (~1.8k lines) plus image and conformance tests. Not worth it while option 2 exists.

Sources: Kasm Developer API docs (1.11 and 1.17): `exec_command_kasm`, `request_kasm`, `get_kasm_status`, `keepalive`, `destroy_kasm`, `get_kasm_screenshot`, API key permissions.
