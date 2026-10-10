// The only bridge between the page and the desktop shell: screen picking, hotkeys and the recording title.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("swDesktop", {
  onPickSource(handler) {
    ipcRenderer.on("sw:pick-source", async (_e, reqId, sources) => {
      let chosen = null;
      try { chosen = await handler(sources); } catch { chosen = null; }
      ipcRenderer.send("sw:picked", reqId, chosen);
    });
  },
  onHotkey(handler) { ipcRenderer.on("sw:hotkey", (_e, name) => handler(name)); },
  setRecording(on) { ipcRenderer.send("sw:recording", !!on); },
  screenshot() { return ipcRenderer.invoke("sw:screenshot"); },
  version() { return ipcRenderer.invoke("sw:version"); },
  onUpdateReady(handler) { ipcRenderer.on("sw:update-ready", (_e, v) => handler(v)); },
  installUpdate() { ipcRenderer.send("sw:install-update"); },
  onClinicalShot(handler) { ipcRenderer.on("sw:clinical-shot", (_e, shots) => handler(shots)); },
});
