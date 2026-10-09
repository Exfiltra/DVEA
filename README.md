<p align="center">
  <img src="assets/dvea-logo-primary-crimson.svg" alt="DVEA — Damn Vulnerable Electron App" width="420" />
</p>

# DVEA — Damn Vulnerable Electron App

DVEA is a purpose-built, intentionally vulnerable [Electron](https://www.electronjs.org/) desktop
application for learning and teaching Electron-specific security issues. It's built for conference
demos, internal security-training sessions, and self-paced learning by developers, security
engineers, and trainers. Every "vulnerability" in the app is deliberate, kept genuinely
exploitable, and mapped to a real Electron trust boundary — this is not a generic web-app
vulnerability set relabeled for Electron.

**Presented at:** BSides Toronto 2026 ([talk recording](https://youtu.be/aoojMb4_4Lw)) · SecTor Arsenal 2026

> **This is not the only Electron security training tool.** It's one purpose-built option, aimed
> at teaching Electron's specific trust boundaries (preload bridges, `contextIsolation`, IPC,
> protocol handlers) rather than generic web vulnerabilities running inside a desktop shell.

---

## ⚠️ Threat model & safety notice

DVEA is **intentionally vulnerable software**. Its main process really does read arbitrary files
from disk on request, really does write attacker-supplied content to attacker-supplied paths,
really does execute shell commands from a compromised renderer in some modules, and really does
fetch and execute unsigned "update" payloads. None of this is simulated.

- **Never run DVEA on a machine that holds sensitive data**, is joined to a production network,
  or is reachable from an untrusted network. Treat it like a live-fire range, not a browser tab.
- **Never expose DVEA's demo services (the local update feed server, deep-link registration,
  etc.) to any network beyond localhost.**
- Run it in a disposable VM, a container, or a dedicated training machine wherever possible.
- Every "attack" DVEA demonstrates is real code executing with the same privileges as the app
  itself — Node.js and OS access, not a sandboxed simulation.

### What DVEA teaches

Electron apps combine a Chromium renderer with a privileged Node.js main process. DVEA maps its
modules onto the trust boundaries that decision creates:

| Trust boundary | What can go wrong | DVEA module(s) |
|---|---|---|
| **Inbound custom protocol** (`dvea://`) | The OS hands a URL to the main process on a deep link; if the main process trusts it, an attacker who gets a victim to click a link controls what the trusted app window shows or reads | Deep Link Hijacking (Untrusted Navigation, Path Traversal) |
| **Outbound protocol dispatch** (`shell.openExternal`) | The renderer/main process hands a URL to the OS's own protocol handlers with no allowlist — any registered scheme (`mailto:`, `file:`, a custom handler) is reachable | openExternal Abuse |
| **IPC handlers** (`ipcMain.handle` / `.on`) | A handler trusts renderer-supplied arguments (a file path, a shell command, an update manifest) without validating them, letting a compromised renderer reach the filesystem, the shell, or the network as the main process | Insecure File Write, Insecure Auto-Update, XSS Challenge 2 (Bridged) |
| **Preload bridges** (`contextBridge`) | A bridge API is well-isolated (`contextIsolation: true`) but still overprivileged — the *shape* of the exposed API, not the isolation flags, is the actual attack surface | XSS Challenge 2 (Bridged), Stored HTML Injection → IPC Token Exfiltration |
| **Renderer → main escalation via `webPreferences`** | `nodeIntegration: true` / `contextIsolation: false` / `sandbox: false` turn ordinary renderer script (e.g. injected via XSS) directly into Node code with OS access — no bridge required | XSS Challenge 3 (Owned) |
| **Insecure update mechanisms** | An updater that fetches a manifest/payload over plaintext HTTP and executes it without signature or integrity verification is remote code execution waiting for a MITM | Insecure Auto-Update (cf. CVE-2024-39698) |

The point every module drives home: in Electron, "is this XSS bad?" isn't a fixed answer — it
depends entirely on the `webPreferences` and preload surface of the window it lands in. The same
`innerHTML` injection is contained, catastrophic, or somewhere in between purely as a function of
window configuration (see "What Can XSS Do in Electron?" below).

---

## Signature feature: live observability panels

DVEA ships with a dedicated, locked-down **Config Inspector + IPC Monitor** panel window that
shows, live, across every open vulnerable window at once:

- **Config Inspector** — each window's *effective* `webPreferences` (what Electron actually
  applied, via `getLastWebPreferences()`, not just what was requested), its CSP (from response
  headers or `<meta>` tags), and Electron/Chrome/Node version info.
- **IPC Monitor** — every IPC message crossing the main/renderer boundary in real time: channel,
  direction, sender, and (size-capped, redactable) arguments.

The panel itself is deliberately isolated from the vulnerable surface it observes: it runs with
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a read-only preload, and
receives updates one-way over a reserved channel (`__dvea_monitor__`) that the IPC Monitor itself
always filters out of its own log. See [`docs/architecture.md`](./docs/architecture.md) for the
full data-flow diagram.

This is what makes DVEA useful for teaching, not just for exploiting: you can watch, in the same
window, exactly which `webPreferences` flag or which IPC handler turned a contained bug into an
RCE.

---

## Module index

All modules are reachable from the app's home screen (`index.html`), grouped and rated **easy /
medium / hard / insane**. Difficulty reflects how much the player has to discover, not how
dangerous the underlying bug is — several "easy" and "medium" modules have full RCE impact.

| # | Module | Difficulty | Trust boundary | CVE reference |
|---|---|---|---|---|
| 01 | **Deep Link Hijacking** → Deep Link → Untrusted Navigation | Easy | Inbound protocol | — |
| 01 | **Deep Link Hijacking** → Deep Link → Path Traversal | Medium | Inbound protocol | — |
| 02 | **Insecure File Write** (IPC Abuse) — 3 flag-gated tasks | Medium | IPC handler | — |
| 03 | **openExternal Abuse** | Medium | Outbound protocol | cf. CVE‑2020‑25019 |
| 04 | **What Can XSS Do in Electron?** — Challenge 1: Contained — 4 flag-gated tasks | Medium | Renderer only (hardened) | — |
| 04 | **What Can XSS Do in Electron?** — Challenge 2: Bridged — 3 flag-gated tasks | Hard | Overprivileged preload bridge | cf. CVE‑2020‑25019 (shape) |
| 04 | **What Can XSS Do in Electron?** — Challenge 3: Owned — 3 flag-gated tasks | Hard | `nodeIntegration` escalation | cf. CVE‑2020‑16608 |
| 05 | **Insecure Auto-Update** — 3 flag-gated tasks, vuln/hardened toggle | Hard | Update mechanism | cf. CVE‑2024‑39698 |
| 06 | **★ Stored HTML Injection → IPC Token Exfiltration** — the flagship challenge | Insane | CSP bypass → preload bridge → IPC | — |

**The flagship challenge's solution is deliberately withheld** — it is being held back until after
the conference talks this app was built for. Every other challenge-style module has a companion
writeup (see below); the flagship does not, on purpose.

---

## Quickstart

### Install & run

```sh
git clone https://github.com/njmulsqb/DVEA
cd DVEA
npm install
npm start
```

Requires **Node ≥20** (built and tested on Node 22). Built and tested on **Ubuntu/Linux** —
macOS may work, Windows is untested. Pre-built Linux (`.deb`) binaries are also published on the
[GitHub releases page](https://github.com/njmulsqb/DVEA/releases/latest); for macOS/Windows,
build from source.

### Linux: Electron sandbox setuid step (required)

Electron's sandboxed renderer processes need their `chrome-sandbox` helper owned by `root` with
the setuid bit set. `npm install` does **not** set this up — run it by hand after every fresh
install:

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

macOS and Windows do not need this step.

**Troubleshooting — hardened windows report `Sandbox: false`:** if a module's checklist badges or
the Config Inspector show `Sandbox: false` for a window that's supposed to be hardened (e.g. XSS
Challenge 1 — Contained), the setuid bit above has most likely reset. This happens on **every**
`node_modules` reinstall/`npm install`, not just the first one. Verify with:

```sh
ls -l node_modules/electron/dist/chrome-sandbox
```

Expected output starts with `-rwsr-xr-x root root` (note the `s` in the owner-execute position).
If it instead shows a non-root owner or no setuid bit, re-run the `chown`/`chmod` commands above.

### Tests

```sh
npm test
```

Runs the Playwright suite (`playwright.config.js`, `tests/*.spec.js`) — each spec launches the
real packaged-from-source Electron app end to end (no browser-only projects, no mocked IPC).

---

## Documentation & writeups

Most challenge-style modules deliberately ship **without** an in-app solution: an objective, a
live playground, and (where applicable) flag-gated tasks that award `DVEA{...}` flags from real
evidence — never fabricated in the renderer. The corresponding solution — real vulnerable code,
a working exploit, the fix, and why it works — lives in [`writeups/`](./writeups), not in the app.

**The flagship challenge (Stored HTML Injection → IPC Token Exfiltration) has no writeup in this
repository.** Its solution is intentionally withheld until after the conference talks this app
supports; publishing it early would give away the answer to a challenge still being used live.

See also:
- [`docs/architecture.md`](./docs/architecture.md) — main process, module launch paths, and the
  observability data flow, as a diagram.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to contribute, including the module-authoring guide
  for adding new vulnerability modules.

---

## License

MIT — see [`LICENSE`](./LICENSE).
