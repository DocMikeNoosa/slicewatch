// SliceWatch desktop shell: serves the web app from inside the package, picks the screen to watch,
// and adds global hotkeys so recording can be started and stopped while PACS has focus.
const { app, BrowserWindow, protocol, net, session, desktopCapturer, ipcMain, globalShortcut, shell, dialog, Menu, screen } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

// Packaged: web files are copied into the app. Development: use the sibling web folder directly.
const WEB_ROOT = app.isPackaged ? path.join(__dirname, "web") : path.join(__dirname, "..", "web");
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) { app.quit(); }
let win = null;
let pickSeq = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 980, minWidth: 900, minHeight: 640,
    backgroundColor: "#0c1014", title: "SliceWatch",
    icon: path.join(WEB_ROOT, "icons", "icon-512.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadURL("app://slicewatch/index.html");
  // Links open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("app://slicewatch/")) e.preventDefault(); });
  // The page asks before closing when a study is open; Electron needs us to show that question.
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win, { type: "question", buttons: ["Close", "Stay"], defaultId: 1, cancelId: 1, title: "SliceWatch", message: "Close SliceWatch?", detail: "The captured slices and the current read will be lost." });
    if (choice === 0) e.preventDefault();
  });
  win.on("closed", () => { win = null; });
}

function askRendererToPick(sources) {
  return new Promise((resolve) => {
    const id = ++pickSeq;
    const done = (_e, reqId, chosen) => { if (reqId !== id) return; ipcMain.removeListener("sw:picked", done); resolve(chosen); };
    ipcMain.on("sw:picked", done);
    win.webContents.send("sw:pick-source", id, sources);
  });
}

app.whenReady().then(() => {
  protocol.handle("app", (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "") || "index.html";
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Screen capture: show our own picker with live thumbnails of each screen and window.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      // Ask for screens and windows separately: on some systems the combined request comes back empty.
      const opts = { thumbnailSize: { width: 400, height: 250 } };
      const screens = await desktopCapturer.getSources({ ...opts, types: ["screen"] }).catch(() => []);
      const windows = await desktopCapturer.getSources({ ...opts, types: ["window"] }).catch(() => []);
      const sources = screens.concat(windows);
      const list = sources.filter((s) => !/^SliceWatch$/.test(s.name)).map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
      if (!list.length) { callback({}); return; }
      const chosen = list.length === 1 ? list[0].id : await askRendererToPick(list);
      const src = sources.find((s) => s.id === chosen);
      if (src) callback({ video: src }); else callback({});
    } catch (err) {
      console.error(err); callback({});
    }
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [{ role: "quit", label: "Exit" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Help", submenu: [{ label: "Ctrl+Shift+R  Record / stop and read", enabled: false }, { label: "Ctrl+Shift+K  Save a key slice", enabled: false }, { label: "Ctrl+Shift+C  Snap clinical details", enabled: false }] },
  ]));

  createWindow();
  const send = (name) => () => win && win.webContents.send("sw:hotkey", name);
  const ok1 = globalShortcut.register("CommandOrControl+Shift+R", send("record"));
  const ok2 = globalShortcut.register("CommandOrControl+Shift+K", send("snap"));
  // Ctrl+Shift+C from the EMR: photograph the screen as it is, then bring SliceWatch forward to select the notes.
  const ok3 = globalShortcut.register("CommandOrControl+Shift+C", async () => {
    if (!win) return;
    try { const shots = await grabScreens(false); win.webContents.send("sw:clinical-shot", shots); } catch (e) { console.error(e); }
    if (win.isMinimized()) win.restore(); win.show(); win.focus();
  });
  if (!ok1 || !ok2 || !ok3) console.warn("A SliceWatch hotkey is already used by another program.");
});

// Full-resolution screenshots of every display, the one under the mouse first.
// From the button, SliceWatch steps out of the way first so it does not photograph itself.
async function grabScreens(hideSelf) {
  let restore = false;
  if (hideSelf && win && win.isVisible() && !win.isMinimized()) { win.minimize(); restore = true; await new Promise((r) => setTimeout(r, 450)); }
  try {
    const displays = screen.getAllDisplays();
    const w = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
    const h = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: w, height: h } });
    const under = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return sources
      .map((s, i) => ({ name: sources.length > 1 ? `Screen ${i + 1}` : "Screen", url: s.thumbnail.toDataURL(), first: String(s.display_id) === String(under.id) }))
      .sort((a, b) => b.first - a.first);
  } finally {
    if (restore && win) { win.restore(); win.focus(); }
  }
}
ipcMain.handle("sw:screenshot", () => grabScreens(true));

ipcMain.on("sw:recording", (_e, on) => { if (win) win.setTitle(on ? "SliceWatch ● Recording" : "SliceWatch"); });
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
