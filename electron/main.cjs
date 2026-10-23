// Desktop shell: runs the local server in-process and shows the UI in a
// window whose tabs can also hold real web pages (<webview>).
const { app, BrowserWindow, shell, ipcMain, session, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

// WebMCP: tools that web pages offer to AI agents. The bridge must run in each
// page before the page's own scripts, so it's a preload for the web tabs' session
// that only pushes the bridge into the page (contextBridge.executeInMainWorld):
// the page gets nothing else from it. Sandboxed preloads can't read files, so the
// preload is written out with the bridge inside.
const WEBMCP_BRIDGE = fs.readFileSync(path.join(__dirname, 'webmcp-bridge.js'), 'utf8');
function addWebMcp(ses) {
  const file = path.join(app.getPath('userData'), 'webmcp-preload.cjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `require('electron').contextBridge.executeInMainWorld({ func: function () {\n${WEBMCP_BRIDGE}\n} });\n`);
  if (typeof ses.registerPreloadScript === 'function') ses.registerPreloadScript({ type: 'frame', id: 'mcpb-webmcp', filePath: file });
  else ses.setPreloads([...ses.getPreloads(), file]);
}

let win = null;
let serverApp = null;
let port = Number(process.env.PORT) || 7777;

async function startServer() {
  const { createServer } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'server.js')).href);
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      serverApp = createServer({ port });
      await new Promise((resolve, reject) => {
        serverApp.server.once('error', reject);
        serverApp.listen().then(resolve);
      });
      serverApp.engine.startWatches();
      const info = serverApp.engine.registryInfo();
      if (!info.syncedAt || info.stale || Date.now() - Date.parse(info.syncedAt) > 24 * 3600_000) {
        serverApp.engine.syncRegistry({ full: !info.syncedAt }).catch(() => {});
      } else serverApp.engine.buildEmbeddings();
      return;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      await serverApp.engine.close();
      port++;
    }
  }
  throw new Error('no free port');
}

const isLocal = (u) => {
  try {
    const x = new URL(u);
    return x.hostname === '127.0.0.1' && Number(x.port) === port;
  } catch {
    return false;
  }
};

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 400,
    title: 'MCP Browser',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#eef1f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);

  // The UI window itself never leaves the local app.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isLocal(url)) {
      e.preventDefault();
      win.webContents.send('open-tab', url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) win.webContents.send('open-tab', url);
    return { action: 'deny' };
  });

  // Lock down every <webview>: no preload, no node, http(s) only.
  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^https?:\/\//i.test(params.src || '')) e.preventDefault();
  });
  // Right-click selected text, in a web page or in the app: cross-check it or search it.
  const selectionMenu = (wc) =>
    wc.on('context-menu', (_e, params) => {
      const text = String(params.selectionText || '').replace(/\s+/g, ' ').trim();
      if (!text || !win) return;
      const short = text.length > 40 ? `${text.slice(0, 40)}…` : text;
      Menu.buildFromTemplate([
        { label: `Cross-check “${short}”`, click: () => win.webContents.send('open-entry', { kind: 'check', claim: text.slice(0, 300) }) },
        { label: `Search MCP Browser for “${short}”`, click: () => win.webContents.send('open-entry', { kind: 'search', query: text.slice(0, 300) }) },
        { type: 'separator' },
        { role: 'copy' },
      ]).popup({ window: win });
    });
  selectionMenu(win.webContents);
  win.webContents.on('did-attach-webview', (e, wc) => {
    selectionMenu(wc);
    // Fallback if the preload didn't run (the bridge returns early when it's there).
    wc.on('dom-ready', () => wc.executeJavaScript(WEBMCP_BRIDGE).catch(() => {}));
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) win.webContents.send('open-tab', url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (ev, url) => {
      if (/^https?:/i.test(url)) return;
      ev.preventDefault();
      // Pages may ask for mail/phone links only. Other schemes (ms-msdt:, search-ms:,
      // file:, smb:, custom app handlers) can launch programs, so they are dropped.
      if (/^(mailto|tel):/i.test(url)) shell.openExternal(url).catch(() => {});
    });
  });
}

// Web pages in tabs never get camera, microphone, location, notifications, etc.
// The app's own window may write to the clipboard (Copy buttons); nothing else is granted.
function isAppWindow(wc) {
  return Boolean(win && wc === win.webContents && isLocal(wc.getURL()));
}
// The app's own window may also show notifications (watches that changed); web pages may not.
const APP_PERMISSIONS = new Set(['clipboard-sanitized-write', 'notifications']);
function lockPermissions(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(APP_PERMISSIONS.has(permission) && isAppWindow(wc)));
  ses.setPermissionCheckHandler((wc, permission) => APP_PERMISSIONS.has(permission) && isAppWindow(wc));
  ses.setDevicePermissionHandler?.(() => false);
}

// Dev mode (npm run desktop:dev): relaunch when server code changes. The page
// reloads itself when the UI changes (it watches the server's build id).
function watchForChanges() {
  const fs = require('node:fs');
  let timer = null;
  for (const dir of ['src', 'bin']) {
    try {
      fs.watch(path.join(__dirname, '..', dir), { recursive: true }, (ev, file) => {
        if (!file || /\.(tmp|swp)$|~$|github-stars\.json/.test(file)) return;
        clearTimeout(timer);
        // Updates arrive as many files at once: wait until they settle.
        timer = setTimeout(() => {
          console.log(`[dev] ${dir}/${file} changed: restarting`);
          app.relaunch();
          app.quit();
        }, 1500);
      });
    } catch (e) {
      console.warn('[dev] cannot watch', dir, e.message);
    }
  }
}

app.whenReady().then(async () => {
  lockPermissions(session.fromPartition('persist:web'));
  addWebMcp(session.fromPartition('persist:web'));
  lockPermissions(session.defaultSession);
  await startServer();
  if (process.env.MCPB_DEV === '1') watchForChanges();
  ipcMain.handle('mcpb:open-external', (e, url) => (/^https?:\/\//i.test(url) ? shell.openExternal(url) : null));
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
// Electron doesn't wait for async quit handlers: hold the quit, save, then exit.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !serverApp) return;
  e.preventDefault();
  quitting = true;
  serverApp.server.closeAllConnections?.();
  serverApp.engine.health.flush();
  Promise.race([serverApp.close(), new Promise((r) => setTimeout(r, 3000))])
    .catch(() => {})
    .finally(() => app.exit(0));
});
