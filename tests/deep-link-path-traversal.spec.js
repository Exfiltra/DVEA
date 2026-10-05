// Behavioral tests for Deep Link Hijacking → Path Traversal (arbitrary file read).
//
// Drives the REAL Electron app (via Playwright's `_electron`) rather than importing internal
// functions, so these exercise the actual unvalidated fs.readFile in main, the actual IPC
// plumbing and the actual renderer wiring. Everything runs from source — no packaged build and
// no OS scheme registration required.
//
// The two delivery paths are asserted separately because they are genuinely different code and
// have failed independently: the REAL dvea://open?path=... link (main reads the file and PUSHES
// it over the 'deeplink-open' channel) versus the simulator button (invoke(), content returned
// as a value). A bug in the push path once went unnoticed precisely because the simulator, which
// never touches that listener, kept working.
//
// Three things about this app make naive assertions silently wrong; each is relied on below:
//   1. BrowserWindow.getAllWindows() omits windows built through the `Window` subclass
//      (src/main/windows/Window.js) — including the main window. Enumerate webContents instead.
//   2. This route NAVIGATES the existing main window, so Playwright's 'window' creation event
//      never fires for it. Poll instead of waiting on that event.
//   3. The simulator lives inside a <details> that is collapsed by default.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test, expect, _electron: electron } = require('@playwright/test');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON_BIN = path.join(
  APP_DIR,
  'node_modules/electron/dist/electron' + (process.platform === 'win32' ? '.exe' : '')
);
const PAGES_DIR = path.join(APP_DIR, 'src/renderer/pages');
const ROUTE_PAGE = 'deep-link-path-traversal.html';
const ROUTE_URL = pathToFileURL(path.join(PAGES_DIR, ROUTE_PAGE)).href;

// A file this test owns, outside the app directory. Using our own file rather than /etc/passwd
// keeps the assertion exact and the suite portable, while still proving the read escapes the
// app's own tree — which is the whole vulnerability.
const OUTSIDE_FILE = path.join(os.tmpdir(), `dvea-test-traversal-${process.pid}.txt`);
const OUTSIDE_CONTENT = 'DVEA_TEST_OUTSIDE_APP_DIR_MARKER';

// The bundled marker file the lab suggests as a first, reliable target.
const BUNDLED_SECRET = path.join(PAGES_DIR, 'secret.txt');

const ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_NO_ATTACH_CONSOLE: '' };

// Every launch needs its own userData: the single-instance lock in main.js is keyed on it, so
// without this a second instance — another spec running in parallel, or a DVEA the developer
// already has open — is refused and quits instead of starting.
let uddCounter = 0;
const nextUserDataDir = () =>
  path.join(os.tmpdir(), `dvea-test-dl-path-${process.pid}-${++uddCounter}`);

function appArgs(userDataDir, extraArgs = []) {
  // --no-sandbox keeps this runnable where chrome-sandbox hasn't had the setuid fix applied
  // (see the Linux note in README/CLAUDE.md). It affects nothing under test here.
  return [APP_DIR, '--no-sandbox', `--user-data-dir=${userDataDir}`, ...extraArgs];
}

function launchApp(extraArgs = [], userDataDir = nextUserDataDir()) {
  return electron.launch({
    executablePath: ELECTRON_BIN,
    cwd: APP_DIR,
    args: appArgs(userDataDir, extraArgs),
    env: ENV,
    timeout: 30_000,
  });
}

const pageUrls = (app) => app.windows().map((w) => w.url());

// See note 2: poll rather than waiting on a 'window' event.
async function pageFor(app, fragment) {
  await expect
    .poll(() => pageUrls(app).some((u) => u.includes(fragment)), {
      message: `no window ever showed ${fragment}`,
      timeout: 20_000,
    })
    .toBe(true);
  return app.windows().find((w) => w.url().includes(fragment));
}

const fileOutput = async (page) => (await page.locator('#file-output').textContent()).trim();

// Expand the collapsed <details> the way a user does, rather than reaching past the UI.
async function openSimulator(page) {
  await page.waitForSelector('#simulate-open', { state: 'attached' });
  await page.evaluate(() => {
    const details = document.getElementById('simulate-open')?.closest('details');
    if (details) details.open = true;
  });
  await page.waitForSelector('#simulate-open', { state: 'visible' });
}

test.beforeAll(() => {
  fs.writeFileSync(OUTSIDE_FILE, OUTSIDE_CONTENT + '\n');
});

test.afterAll(() => {
  try {
    fs.unlinkSync(OUTSIDE_FILE);
  } catch {}
});

test.describe('Deep Link → Path Traversal', () => {
  test.describe('a real dvea:// deep link', () => {
    test('COLD START: dvea://open?path= reads the file and renders it', async () => {
      // Guards two regressions at once, both of which produced the same silent symptom:
      //   - Nothing read the deep link out of process.argv on a cold start, so handleDeepLink()
      //     never ran ('open-url' is macOS-only; 'second-instance' needs the lock).
      //   - vuln-openfile.js registered its listener behind `window.ipc.onDeepLinkOpen`, but
      //     preload.js exposes onDeepLinkOpen on window.api. The guard was permanently false, so
      //     main's 'deeplink-open' message had no receiver even after the file had been read.
      const app = await launchApp([`dvea://open?path=${OUTSIDE_FILE}`]);
      try {
        const win = await pageFor(app, ROUTE_PAGE);
        await expect.poll(() => fileOutput(win), { timeout: 15_000 }).toContain(OUTSIDE_CONTENT);
      } finally {
        await app.close().catch(() => {});
      }
    });

    test('ALREADY RUNNING: a second launch is routed to the first instance', async () => {
      // Guards the single-instance lock. Without it the OS starts a SECOND independent app
      // process, 'second-instance' never fires on the running one, the link is dropped, and the
      // user is left with a duplicate window.
      const shared = nextUserDataDir();
      const app = await launchApp([], shared);
      try {
        await pageFor(app, 'index.html');
        const before = pageUrls(app).length;

        // A real second process, exactly as the OS would start one for the URL.
        const child = spawn(ELECTRON_BIN, appArgs(shared, [`dvea://open?path=${OUTSIDE_FILE}`]), {
          cwd: APP_DIR,
          env: ENV,
          stdio: 'ignore',
        });
        const exitCode = await new Promise((resolve) => {
          child.on('exit', resolve);
          setTimeout(() => resolve('STILL RUNNING'), 20_000);
        });
        expect(exitCode, 'the second process should quit, not become a duplicate app').not.toBe(
          'STILL RUNNING'
        );

        const win = await pageFor(app, ROUTE_PAGE);
        await expect.poll(() => fileOutput(win), { timeout: 15_000 }).toContain(OUTSIDE_CONTENT);
        expect(pageUrls(app).length, 'a duplicate window appeared').toBe(before);
      } finally {
        await app.close().catch(() => {});
      }
    });

    test('a nonexistent path surfaces the read error instead of failing silently', async () => {
      const missing = path.join(os.tmpdir(), 'dvea-definitely-not-here-9e1f.txt');
      const app = await launchApp([`dvea://open?path=${missing}`]);
      try {
        const win = await pageFor(app, ROUTE_PAGE);
        await expect.poll(() => fileOutput(win), { timeout: 15_000 }).toContain('Read failed');
      } finally {
        await app.close().catch(() => {});
      }
    });
  });

  test.describe('the in-app simulator', () => {
    let app;
    let mainWindow;

    test.beforeAll(async () => {
      app = await launchApp();
      mainWindow =
        app.windows().find((w) => w.url().includes('index.html')) ||
        (await app.waitForEvent('window', {
          predicate: (w) => w.url().includes('index.html'),
          timeout: 15_000,
        }));
      await mainWindow.waitForLoadState('domcontentloaded');
    });

    test.afterAll(async () => {
      await app?.close().catch(() => {});
    });

    async function gotoRoute(from = 'index') {
      await mainWindow.goto(`${ROUTE_URL}?from=${from}`);
      await openSimulator(mainWindow);
    }

    async function readPath(target) {
      await gotoRoute();
      await mainWindow.fill('#path', target);
      await mainWindow.click('#simulate-open');
    }

    test('the hub links to this route', async () => {
      await mainWindow.goto(pathToFileURL(path.join(PAGES_DIR, 'index.html')).href);
      await mainWindow.click(`a[href="${ROUTE_PAGE}?from=index"]`);
      await mainWindow.waitForSelector('#simulate-open', { state: 'attached' });
      expect(mainWindow.url()).toContain(ROUTE_PAGE);
    });

    test('reads a file outside the app directory — there is no path validation', async () => {
      // This IS the vulnerability. If it ever starts failing, validation was added and the lab
      // is no longer exploitable.
      await readPath(OUTSIDE_FILE);
      await expect.poll(() => fileOutput(mainWindow), { timeout: 15_000 }).toContain(OUTSIDE_CONTENT);
    });

    test('reads the bundled marker file the lab suggests as a first target', async () => {
      await readPath(BUNDLED_SECRET);
      await expect
        .poll(() => fileOutput(mainWindow), { timeout: 15_000 })
        .toContain('DVEA{arbitrary_file_read_via_deep_link}');
    });

    test('traversal sequences escape the app directory', async () => {
      // Reach OUTSIDE_FILE from inside the app's own pages directory using ../ segments, which is
      // the shape of the attack the lab is named for, rather than an already-absolute path.
      // Built by concatenation on purpose: path.join() would collapse the ../ segments and the
      // handler would never see them.
      const traversal = PAGES_DIR + path.sep + path.relative(PAGES_DIR, OUTSIDE_FILE);
      expect(traversal).toContain('..');
      await readPath(traversal);
      await expect.poll(() => fileOutput(mainWindow), { timeout: 15_000 }).toContain(OUTSIDE_CONTENT);
    });

    test('a nonexistent path reports the error', async () => {
      await readPath(path.join(os.tmpdir(), 'dvea-definitely-not-here-4c2a.txt'));
      await expect.poll(() => fileOutput(mainWindow), { timeout: 15_000 }).toContain('Read failed');
    });

    test('an empty path is a no-op', async () => {
      await gotoRoute();
      await mainWindow.fill('#path', '');
      await mainWindow.click('#simulate-open');
      await mainWindow.waitForTimeout(1_000);
      expect(await fileOutput(mainWindow)).toBe('');
    });

    test('the back link honors ?from=', async () => {
      await gotoRoute('index');
      await expect(mainWindow.locator('#back-link')).toHaveText('← All Vulnerabilities');
      await expect(mainWindow.locator('#back-link')).toHaveAttribute('href', 'index.html');

      await gotoRoute('parent');
      await expect(mainWindow.locator('#back-link')).toHaveText('← Deep Link Hijacking');
      await expect(mainWindow.locator('#back-link')).toHaveAttribute('href', 'deep-link-hijacking.html');

      await mainWindow.goto(ROUTE_URL);
      await openSimulator(mainWindow);
      await expect(mainWindow.locator('#back-link')).toHaveAttribute('href', 'deep-link-hijacking.html');
    });
  });
});
