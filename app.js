"use strict";
const $ = (s) => document.querySelector(s);
const WINDOWS = ["Auto", "Soft tissue", "Lung", "Bone", "Brain", "Subdural", "Stroke", "Liver", "Angio / MIP"];
const MAX_FRAMES = 400;
const SIG = 96;          // signature size used to decide "is this a new slice?"
const CM_W = 128;        // change-map width used to find the image viewport
const STORE_MAX = 2560;  // longest side kept per captured frame
const desktop = window.swDesktop || null;   // present only in the installed Windows app

const state = {
  mode: null, stream: null, capturing: false,
  crop: { x: 0, y: 0, w: 1, h: 1 }, cropSet: false,
  label: "Auto",
  frames: [], nextId: 1,
  lastSig: null, recent: [],
  changeMaps: new Map(),   // per frame size: where pixels change between slices
  masks: new Map(),        // per frame size: boxes of on-screen text to black out
  convo: null, busy: false, ctl: null,
  reportMd: "", qa: [],
};

/* ---------- settings ---------- */
const store = {
  get(k) { try { return localStorage.getItem("sw." + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem("sw." + k) : localStorage.setItem("sw." + k, v); } catch { } },
};
const settings = {
  key: store.get("key") || "",
  remember: !!store.get("key"),
  autoRead: store.get("auto") !== "0",
  model: store.get("model") || "claude-opus-5-5",
  effort: store.get("effort") || "high",
  maxImages: +(store.get("max") || 40),
  tile: store.get("tile") || "auto",
  thorough: store.get("thorough") === "1",
  sens: +(store.get("sens") || 6),
};
function saveSettings() {
  store.set("key", settings.remember && settings.key ? settings.key : null);
  store.set("auto", settings.autoRead ? "1" : "0");
  store.set("model", settings.model); store.set("effort", settings.effort);
  store.set("max", String(settings.maxImages)); store.set("tile", settings.tile);
  store.set("thorough", settings.thorough ? "1" : "0"); store.set("sens", String(settings.sens)); store.set("live", settings.live === false ? "0" : "1");
}
// Percent of the picture (at 96×96) that must change for a frame to count as a new slice.
// A still screen measures 0; a cursor or a changing slice counter is under 0.1%; a new CT slice changes far more.
const threshold = () => [8, 5, 3.5, 2.5, 1.6, 1.0, 0.6, 0.4, 0.25, 0.12][settings.sens - 1];

/* ---------- small UI helpers ---------- */
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 4200); }
function setStatus(t) { $("#status").hidden = !t; if (t) $("#statusText").textContent = t; }
function showErr(t) { $("#err").hidden = !t; $("#err").textContent = t || ""; }
function syncButtons() {
  const rec = $("#btnRecord");
  rec.classList.toggle("on", state.capturing);
  $("#recLabel").textContent = state.capturing ? (settings.autoRead ? "Stop & read" : "Stop") + ` (${state.frames.length})` : state.mode === "file" ? "Play & capture" : "Record";
  rec.disabled = state.busy && !state.capturing;
  $("#btnSnap").disabled = !state.mode;
  $("#btnStop").disabled = !state.mode;
  $("#btnStop").textContent = state.mode === "file" ? "Close recording" : "Stop sharing";
  $("#btnClear").disabled = !state.frames.length || state.busy;
  $("#btnAnalyze").disabled = !state.frames.length || state.busy;
  $("#btnAbort").hidden = !state.busy;
  $("#fuBtn").disabled = state.busy;
  const p = $("#pill");
  p.className = "pill" + (state.capturing ? " rec" : state.mode ? " live" : "");
  p.textContent = state.capturing ? "Recording" : state.mode === "screen" ? "Watching, paused" : state.mode === "file" ? "Recording loaded" : "Not recording";
  updatePlan();
}
function renderChips() {
  const box = $("#chips"); box.textContent = "";
  WINDOWS.forEach((w, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.setAttribute("aria-pressed", String(state.label === w));
    b.innerHTML = `<kbd>${i + 1}</kbd>`; b.append(w);
    b.title = w === "Auto" ? "Claude identifies the window itself" : `Tag slices as ${w} window`;
    b.onclick = () => { state.label = w; renderChips(); };
    box.append(b);
  });
}

/* ---------- screen sharing ---------- */
const video = $("#video");
let processorReader = null, workerTimer = null;

async function startShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) { toast("This browser can't share the screen. Use Chrome or Edge, or the Windows app."); return false; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 }, cursor: "never" }, audio: false });
  } catch (e) {
    toast(e?.name === "NotAllowedError" ? "Screen sharing was cancelled." : "Couldn't start screen sharing: " + (e?.message || e));
    return false;
  }
  stopSource();
  state.mode = "screen"; state.stream = stream;
  const track = stream.getVideoTracks()[0];
  track.addEventListener("ended", () => { if (state.stream === stream) { const was = state.capturing; stopSource(); toast("Screen sharing ended."); if (was) afterStop(); } });
  video.srcObject = stream; video.hidden = false; $("#stageEmpty").hidden = true;
  await video.play().catch(() => { });
  startLiveLoop(track);
  syncButtons(); sizeOverlay();
  return true;
}
function startLiveLoop(track) {
  // MediaStreamTrackProcessor keeps delivering frames while this window is behind PACS.
  if ("MediaStreamTrackProcessor" in window) {
    const reader = new MediaStreamTrackProcessor({ track: track.clone() }).readable.getReader();
    processorReader = reader;
    let last = 0;
    (async () => {
      for (; ;) {
        let r; try { r = await reader.read(); } catch { break; }
        if (r.done) break;
        const f = r.value, now = performance.now();
        if (now - last >= 90) { last = now; try { processFrame(f, f.displayWidth, f.displayHeight); } catch (e) { console.error(e); } }
        f.close();
      }
    })();
  } else {
    const src = URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),100)"], { type: "text/javascript" }));
    workerTimer = new Worker(src);
    workerTimer.onmessage = () => processFrame(video, video.videoWidth, video.videoHeight);
  }
}

/* ---------- recording files ---------- */
let rvfcActive = false;
function loadVideoFile(file) {
  stopSource();
  state.mode = "file";
  video.srcObject = null; video.src = URL.createObjectURL(file); video.hidden = false; $("#stageEmpty").hidden = true;
  video.onloadedmetadata = () => { video.currentTime = 0; sizeOverlay(); };
  video.onended = () => { if (state.capturing) { setCapturing(false); afterStop(); } };
  syncButtons();
}
function fileLoop() {
  if (!rvfcActive) return;
  processFrame(video, video.videoWidth, video.videoHeight);
  if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(fileLoop); else setTimeout(fileLoop, 60);
}

function stopSource() {
  setCapturing(false);
  if (processorReader) { processorReader.cancel().catch(() => { }); processorReader = null; }
  if (workerTimer) { workerTimer.terminate(); workerTimer = null; }
  if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute("src"); }
  video.srcObject = null; video.load(); video.hidden = true; $("#overlay").hidden = true; $("#stageEmpty").hidden = false;
  state.mode = null; syncButtons();
}
function setCapturing(on) {
  if (on && !state.mode) return;
  if (on && state.frames.length >= MAX_FRAMES) { toast(`Limit of ${MAX_FRAMES} slices reached. Clear some first.`); return; }
  state.capturing = on; state.lastSig = null;
  if (state.mode === "file") {
    if (on) { rvfcActive = true; video.play().then(fileLoop).catch(() => { }); }
    else { rvfcActive = false; video.pause(); }
  }
  desktop?.setRecording?.(on);
  syncButtons();
  window.onCaptureChange?.(on);
}

/* The one button: Record → (choose screen the first time) → capture; press again → stop and read. */
async function toggleRecord() {
  if (state.capturing) { setCapturing(false); afterStop(); return; }
  if (state.busy) return;
  if (!state.mode) { const ok = await startShare(); if (!ok) return; }
  if (state.convo || state.reportMd) resetReport();
  setCapturing(true);
}
function afterStop() {
  const n = state.frames.length;
  if (!n) { toast("No slices were captured. Scroll through the study while recording."); return; }
  if (settings.autoRead) analyze(); else toast(`${n} slices captured. Press Read study when ready.`);
}

/* ---------- optional manual capture box ---------- */
const ov = $("#overlay"), octx = ov.getContext("2d");
function sizeOverlay() {
  if (video.hidden || !video.videoWidth) { ov.hidden = true; return; }
  const r = video.getBoundingClientRect(), sr = $("#stage").getBoundingClientRect();
  const va = video.videoWidth / video.videoHeight, ba = r.width / r.height;
  let w = r.width, h = r.height; if (va > ba) h = w / va; else w = h * va;
  const dpr = window.devicePixelRatio || 1;
  Object.assign(ov.style, { left: (r.left - sr.left + (r.width - w) / 2) + "px", top: (r.top - sr.top + (r.height - h) / 2) + "px", width: w + "px", height: h + "px" });
  ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr);
  ov.hidden = false; drawOverlay();
}
let drag = null;
function drawOverlay() {
  const W = ov.width, H = ov.height, c = state.crop;
  octx.clearRect(0, 0, W, H);
  if (!state.cropSet && !drag) return;
  const x = c.x * W, y = c.y * H, w = c.w * W, h = c.h * H;
  octx.fillStyle = "rgba(0,0,0,.55)";
  octx.fillRect(0, 0, W, y); octx.fillRect(0, y + h, W, H - y - h); octx.fillRect(0, y, x, h); octx.fillRect(x + w, y, W - x - w, h);
  octx.strokeStyle = "#e6b34c"; octx.lineWidth = 2 * (window.devicePixelRatio || 1); octx.strokeRect(x, y, w, h);
}
ov.addEventListener("pointerdown", (e) => { ov.setPointerCapture(e.pointerId); const b = ov.getBoundingClientRect(); drag = { x0: (e.clientX - b.left) / b.width, y0: (e.clientY - b.top) / b.height }; });
ov.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const b = ov.getBoundingClientRect();
  const x1 = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y1 = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
  state.crop = { x: Math.min(drag.x0, x1), y: Math.min(drag.y0, y1), w: Math.abs(x1 - drag.x0), h: Math.abs(y1 - drag.y0) };
  drawOverlay();
});
ov.addEventListener("pointerup", () => {
  if (!drag) return; drag = null;
  if (state.crop.w < 0.03 || state.crop.h < 0.03) { state.crop = { x: 0, y: 0, w: 1, h: 1 }; state.cropSet = false; }
  else state.cropSet = true;
  state.lastSig = null; state.recent = [];
  drawOverlay(); updateCropHint();
});
ov.addEventListener("dblclick", () => { state.crop = { x: 0, y: 0, w: 1, h: 1 }; state.cropSet = false; state.lastSig = null; drawOverlay(); updateCropHint(); });
function updateCropHint() {
  $("#cropHint").textContent = state.cropSet
    ? "Capture limited to the box. Double-click the preview to clear it."
    : "Optional: drag on the preview to limit capture to one area. Without a box, SliceWatch finds the image area itself.";
}
new ResizeObserver(() => sizeOverlay()).observe($("#stage"));
video.addEventListener("loadeddata", sizeOverlay);
video.addEventListener("resize", sizeOverlay);

/* ---------- deciding what is a new slice ---------- */
const sigC = document.createElement("canvas"); sigC.width = sigC.height = SIG;
const sctx = sigC.getContext("2d", { willReadFrequently: true });
const cmC = document.createElement("canvas");
const cmctx = cmC.getContext("2d", { willReadFrequently: true });
function grey(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}
function signature(src, cx, cy, cw, ch) {
  sctx.drawImage(src, cx, cy, cw, ch, 0, 0, SIG, SIG);
  const g = grey(sctx, SIG, SIG);
  let sum = 0, sq = 0; for (const v of g) { sum += v; sq += v * v; }
  const mean = sum / g.length;
  return { g, std: Math.sqrt(Math.max(0, sq / g.length - mean * mean)) };
}
function sigDiff(a, b) { let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 8) n++; return 100 * n / a.length; }
function cropPx(sw, sh) {
  const c = state.crop, cx = Math.round(c.x * sw), cy = Math.round(c.y * sh);
  return [cx, cy, Math.max(16, Math.min(sw - cx, Math.round(c.w * sw))), Math.max(16, Math.min(sh - cy, Math.round(c.h * sh)))];
}
function processFrame(src, sw, sh) {
  if (!state.capturing || !sw || !sh) return;
  const [cx, cy, cw, ch] = cropPx(sw, sh);
  const s = signature(src, cx, cy, cw, ch);
  if (s.std < 2.5) return;                                                  // blank frame
  const t = threshold();
  if (state.lastSig && sigDiff(s.g, state.lastSig) < t) return;              // same slice as last kept
  state.lastSig = s.g;
  if (state.recent.some((r) => sigDiff(s.g, r) < t * 0.3)) return;           // scrolled back over a slice we have
  state.recent.push(s.g); if (state.recent.length > 80) state.recent.shift();
  const f = addFrame(src, cx, cy, cw, ch, false);
  trackChange(src, cx, cy, cw, ch, f);
  if (state.frames.length >= MAX_FRAMES) { setCapturing(false); toast(`Capture stopped at ${MAX_FRAMES} slices.`); afterStop(); }
  else syncButtons();
}
// Accumulate where the picture changes between kept slices; that region is the image viewport.
function trackChange(src, cx, cy, cw, ch, f) {
  const key = f.sizeKey, h = Math.max(8, Math.round(CM_W * ch / cw));
  let cm = state.changeMaps.get(key);
  if (!cm || cm.h !== h) { cm = { w: CM_W, h, counts: new Uint16Array(CM_W * h), prev: null, n: 0 }; state.changeMaps.set(key, cm); }
  cmC.width = CM_W; cmC.height = h;
  cmctx.drawImage(src, cx, cy, cw, ch, 0, 0, CM_W, h);
  const g = grey(cmctx, CM_W, h);
  if (cm.prev) { for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - cm.prev[i]) > 18) cm.counts[i]++; cm.n++; }
  cm.prev = g;
}
// The image area is wherever the picture changed between slices (a lone changed cell, such as a cursor, is ignored),
// widened through the black margin of the viewport so the edges of the anatomy are never cut off.
function autoCrop(key) {
  const cm = state.changeMaps.get(key);
  const full = { x: 0, y: 0, w: 1, h: 1 };
  if (!cm || cm.n < 3) return full;
  const W = cm.w, H = cm.h, cnt = cm.counts;
  const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && cnt[y * W + x] > 0;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!on(x, y)) continue;
    let nb = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && on(x + dx, y + dy)) nb++;
    if (cnt[y * W + x] < 2 && nb < 2) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return full;
  const g = cm.prev, dark = 24;
  const rowDark = (y) => { let s = 0; for (let x = x0; x <= x1; x++) s += g[y * W + x]; return s / (x1 - x0 + 1) < dark; };
  const colDark = (x) => { let s = 0; for (let y = y0; y <= y1; y++) s += g[y * W + x]; return s / (y1 - y0 + 1) < dark; };
  for (let grow = true; grow;) {
    grow = false;
    if (y0 > 0 && rowDark(y0 - 1)) { y0--; grow = true; }
    if (y1 < H - 1 && rowDark(y1 + 1)) { y1++; grow = true; }
    if (x0 > 0 && colDark(x0 - 1)) { x0--; grow = true; }
    if (x1 < W - 1 && colDark(x1 + 1)) { x1++; grow = true; }
  }
  const pad = 1;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const r = { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
  return r.w * r.h < 0.02 ? full : r;
}
function addFrame(src, cx, cy, cw, ch, key, label) {
  const scale = Math.min(1, STORE_MAX / Math.max(cw, ch));
  const c = document.createElement("canvas"); c.width = Math.round(cw * scale); c.height = Math.round(ch * scale);
  c.getContext("2d").drawImage(src, cx, cy, cw, ch, 0, 0, c.width, c.height);
  const t = document.createElement("canvas"), ts = 320 / Math.max(c.width, c.height);
  t.width = Math.max(1, Math.round(c.width * ts)); t.height = Math.max(1, Math.round(c.height * ts));
  t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
  const f = { id: state.nextId++, label: label || state.label, key, w: c.width, h: c.height, sizeKey: `${c.width}x${c.height}`, blob: null, url: "", thumb: t.toDataURL("image/jpeg", 0.7) };
  state.frames.push(f);
  c.toBlob((b) => { f.blob = b; f.url = URL.createObjectURL(b); renderStrip(); window.onFrameReady?.(f); }, "image/jpeg", 0.9);
  return f;
}
function snapKey() {
  if (!state.mode || !video.videoWidth) return;
  const [cx, cy, cw, ch] = cropPx(video.videoWidth, video.videoHeight);
  const f = addFrame(video, cx, cy, cw, ch, true);
  toast(`Key slice #${f.id} saved.`);
}
async function addImageFile(blob) {
  const bmp = await createImageBitmap(blob);
  const f = addFrame(bmp, 0, 0, bmp.width, bmp.height, false);
  bmp.close?.(); return f;
}

/* ---------- captured strip ---------- */
let stripQueued = false;
function renderStrip() {
  if (stripQueued) return; stripQueued = true;
  requestAnimationFrame(() => {
    stripQueued = false;
    const strip = $("#strip"); strip.textContent = "";
    const crops = new Map();
    for (const f of state.frames) {
      if (!crops.has(f.sizeKey)) crops.set(f.sizeKey, autoCrop(f.sizeKey));
      const r = crops.get(f.sizeKey);
      const d = document.createElement("div"); d.className = "thumb" + (f.key ? " key" : ""); d.tabIndex = 0;
      // show only the auto-cropped part of the thumbnail
      const ar = (r.w * f.w) / (r.h * f.h);
      d.innerHTML = `<div class="view" style="width:${ar < 1 ? ar * 100 : 100}%;height:${ar < 1 ? 100 : 100 / ar}%"><img alt="Slice ${f.id}" src="${f.thumb}"
        style="width:${100 / r.w}%;height:${100 / r.h}%;left:${-r.x / r.w * 100}%;top:${-r.y / r.h * 100}%"></div>
        <div class="meta"><span>#${f.id}</span><span></span></div>
        <div class="tools"><button type="button" class="star" title="Mark as key slice">★</button><button type="button" class="del" title="Remove">✕</button></div>`;
      d.querySelector(".meta span:last-child").textContent = f.label === "Auto" ? "" : f.label;
      d.onclick = (e) => { if (!e.target.closest("button")) openLightbox(f.id); };
      d.onkeydown = (e) => { if (e.key === "Enter") openLightbox(f.id); };
      d.querySelector(".star").onclick = () => { f.key = !f.key; renderStrip(); };
      d.querySelector(".del").onclick = () => removeFrame(f.id);
      strip.append(d);
    }
    $("#count").textContent = String(state.frames.length);
    $("#stripEmpty").hidden = state.frames.length > 0;
    strip.hidden = state.frames.length === 0;
    if (state.capturing) strip.scrollTop = strip.scrollHeight;
    syncButtons();
  });
}
function removeFrame(id) {
  const i = state.frames.findIndex((f) => f.id === id); if (i < 0) return;
  URL.revokeObjectURL(state.frames[i].url); state.frames.splice(i, 1); renderStrip();
}
function clearFrames() {
  state.frames.forEach((f) => URL.revokeObjectURL(f.url));
  state.frames = []; state.recent = []; state.lastSig = null; state.changeMaps.clear(); state.masks.clear();
  renderStrip();
}

/* ---------- lightbox ---------- */
let lbId = null;
async function openLightbox(id, srcOverride) {
  const dlg = $("#dlgLb");
  if (srcOverride) {
    lbId = null; $("#lbImg").src = srcOverride; $("#lbTitle").textContent = "Image sent to Claude";
    $("#lbStar").hidden = $("#lbDel").hidden = true; $("#lbNote").textContent = "";
    dlg.showModal(); return;
  }
  const f = state.frames.find((x) => x.id === id);
  if (!f || !f.blob) { toast(`Slice #${id} is not in the current capture.`); return; }
  lbId = id;
  $("#lbStar").hidden = $("#lbDel").hidden = false;
  $("#lbTitle").textContent = `Slice #${id}` + (f.label !== "Auto" ? ` · ${f.label}` : "");
  $("#lbStar").textContent = f.key ? "★ Unmark key slice" : "★ Mark key slice";
  const c = await frameCanvas(f, null);
  $("#lbImg").src = c.toDataURL("image/jpeg", 0.92);
  $("#lbNote").textContent = hasMasks(f.sizeKey) ? "Shown as sent: cropped to the image area, on-screen text blacked out." : "Cropped to the image area. On-screen text is blacked out when the read starts.";
  dlg.showModal();
}
$("#lbClose").onclick = () => $("#dlgLb").close();
$("#lbStar").onclick = () => { const f = state.frames.find((x) => x.id === lbId); if (f) { f.key = !f.key; renderStrip(); } $("#dlgLb").close(); };
$("#lbDel").onclick = () => { removeFrame(lbId); $("#dlgLb").close(); };

/* ---------- on-PC text recognition (Tesseract, runs locally) ---------- */
const OCR = (() => {
  let sched = null, pending = null;
  const base = new URL("vendor/tesseract/", location.href).href;
  async function init() {
    if (sched) return sched;
    if (pending) return pending;
    pending = (async () => {
      if (!window.Tesseract) throw new Error("Text recognition files are missing.");
      const s = Tesseract.createScheduler();
      const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
      for (let i = 0; i < n; i++) {
        const w = await Tesseract.createWorker("eng", 1, { workerPath: base + "worker.min.js", corePath: base + "core", langPath: base + "lang", gzip: true, workerBlobURL: false, cacheMethod: "none" });
        s.addWorker(w);
      }
      sched = s; return s;
    })();
    try { return await pending; } finally { pending = null; }
  }
  async function read(canvas) { const s = await init(); const { data } = await s.addJob("recognize", canvas, {}, { blocks: true, text: true }); return data; }
  return { init, read };
})();

// Bright overlay text on a dark viewport becomes dark-on-white, which Tesseract reads far more reliably.
function ocrCanvas(src, sx, sy, sw, sh) {
  const scale = Math.max(1, Math.min(2.5, 1800 / sw));
  const c = document.createElement("canvas"); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const im = x.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(d[i], d[i + 1], d[i + 2]);   // max channel keeps yellow, green and cyan overlay text bright
    const o = v > 110 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = o;
  }
  x.putImageData(im, 0, 0);
  return c;
}
// Any line Tesseract is reasonably sure is text gets masked whole, with a margin; nearby lines merge into one solid block,
// so no letters survive at the edges of a name.
function textBoxes(data, W, H) {
  const boxes = [];
  for (const bl of data.blocks || []) for (const p of bl.paragraphs || []) for (const l of p.lines || []) {
    const words = (l.words || []).filter((w) => w.confidence >= 40 && /[A-Za-z0-9].*[A-Za-z0-9]/.test(w.text) && !/^(.)\1+$/.test(w.text));
    if (!words.length) continue;
    const lh = l.bbox.y1 - l.bbox.y0;
    if (lh > H * 0.09) continue;                                   // too tall to be overlay text
    const parts = (l.bbox.x1 - l.bbox.x0) > W * 0.6 ? words.map((w) => w.bbox) : [l.bbox];
    for (const b of parts) {
      const px = lh * 1.5, py = lh * 0.6;
      boxes.push({ x: Math.max(0, (b.x0 - px) / W), y: Math.max(0, (b.y0 - py) / H), x2: Math.min(1, (b.x1 + px) / W), y2: Math.min(1, (b.y1 + py) / H) });
    }
  }
  return boxes;
}
// Tesseract sometimes misses one line of an overlay block, or the first letters of a line. Grow each block
// outward while the next strip still holds text-like strokes on a black background (in the thresholded image,
// text is black on white). Anatomy is mostly bright, so growth stops at it; growth is also capped.
function growBoxes(c, boxes) {
  if (!boxes.length) return boxes;
  const W = c.width, H = c.height, d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const frac = (x0, x1, y0, y1) => {
    let n = 0, t = 0;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { t++; if (d[(y * W + x) * 4] === 0) n++; }
    return t ? n / t : 0;
  };
  const texty = (f) => f > 0.004 && f < 0.35;
  return boxes.map((b) => {
    let x0 = Math.round(b.x * W), y0 = Math.round(b.y * H), x1 = Math.round(b.x2 * W), y1 = Math.round(b.y2 * H);
    const h0 = y1 - y0, w0 = x1 - x0, step = Math.max(4, Math.round(h0 / 3));
    const maxUp = y0 - h0 * 3, maxDown = y1 + h0 * 3, maxL = x0 - w0 * 0.6, maxR = x1 + w0 * 0.6;
    for (let grown = true; grown;) {
      grown = false;
      if (y0 - step >= Math.max(0, maxUp) && texty(frac(x0, x1, y0 - step, y0))) { y0 -= step; grown = true; }
      if (y1 + step <= Math.min(H, maxDown) && texty(frac(x0, x1, y1, y1 + step))) { y1 += step; grown = true; }
      if (x0 - step >= Math.max(0, maxL) && texty(frac(x0 - step, x0, y0, y1))) { x0 -= step; grown = true; }
      if (x1 + step <= Math.min(W, maxR) && texty(frac(x1, x1 + step, y0, y1))) { x1 += step; grown = true; }
    }
    // one more step of margin on every side
    x0 = Math.max(0, x0 - step); y0 = Math.max(0, y0 - step); x1 = Math.min(W, x1 + step); y1 = Math.min(H, y1 + step);
    return { x: x0 / W, y: y0 / H, x2: x1 / W, y2: y1 / H };
  });
}
function mergeBoxes(boxes) {
  let list = boxes.map((b) => ({ ...b })), merged = true;
  const touch = (a, b) => a.x <= b.x2 && b.x <= a.x2 && a.y <= b.y2 && b.y <= a.y2;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (touch(list[i], list[j])) {
        const a = list[i], b = list[j];
        list[i] = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
        list.splice(j, 1); merged = true; break outer;
      }
    }
  }
  return list;
}
function sampleForOcr(frames, n) {
  const pick = new Set();
  const step = Math.max(1, (frames.length - 1) / Math.max(1, n - 1));
  for (let i = 0; i < n && Math.round(i * step) < frames.length; i++) pick.add(frames[Math.round(i * step)]);
  const seen = new Set();
  for (const f of frames) { if (f.key) pick.add(f); if (!seen.has(f.label)) { seen.add(f.label); pick.add(f); } }
  return [...pick];
}
async function bitmapOf(f) { return createImageBitmap(f.blob); }
// Overlay text (name, DOB, ID) sits in the same place on every slice, so reading a sample of slices finds it for all of them.
// Boxes are kept in whole-frame coordinates and accumulate over the study, so live updates and the final read share them.
function maskEntry(key) {
  let m = state.masks.get(key);
  if (!m) { m = { boxes: [], done: new Set() }; state.masks.set(key, m); }
  return m;
}
async function buildMasks(frames, onProgress, perGroup = 10) {
  const groups = new Map();
  for (const f of frames) { if (!groups.has(f.sizeKey)) groups.set(f.sizeKey, []); groups.get(f.sizeKey).push(f); }
  const jobs = [];
  for (const [key, list] of groups) {
    const m = maskEntry(key);
    const fresh = list.filter((f) => !m.done.has(f.id));
    if (!fresh.length) continue;
    // Always read at least a few slices of a group we have never read; otherwise a sample of the new ones.
    const want = settings.thorough ? fresh.length : (m.done.size ? Math.min(perGroup, Math.ceil(fresh.length / 4)) : Math.max(3, perGroup));
    const todo = fresh.length <= want ? fresh : sampleForOcr(fresh, want);
    jobs.push({ key, crop: autoCrop(key), todo });
  }
  const total = jobs.reduce((s, j) => s + j.todo.length, 0);
  if (!total) return;
  let done = 0;
  onProgress?.(0, total);
  await OCR.init();
  for (const j of jobs) {
    const m = maskEntry(j.key), cr = j.crop, found = [];
    await Promise.all(j.todo.map(async (f) => {
      const bmp = await bitmapOf(f);
      const c = ocrCanvas(bmp, cr.x * bmp.width, cr.y * bmp.height, cr.w * bmp.width, cr.h * bmp.height); bmp.close?.();
      const data = await OCR.read(c);
      for (const b of growBoxes(c, textBoxes(data, c.width, c.height))) found.push({ x: cr.x + b.x * cr.w, y: cr.y + b.y * cr.h, x2: cr.x + b.x2 * cr.w, y2: cr.y + b.y2 * cr.h });
      m.done.add(f.id);
      onProgress?.(++done, total);
    }));
    m.boxes = mergeBoxes(m.boxes.concat(found));
  }
}
const hasMasks = (key) => (state.masks.get(key)?.done.size || 0) > 0;

/* ---------- choosing and rendering what gets sent ---------- */
function uniform(arr, m) {
  if (m >= arr.length) return arr.slice();
  if (m <= 0) return [];
  if (m === 1) return [arr[Math.floor(arr.length / 2)]];
  const out = []; for (let i = 0; i < m; i++) out.push(arr[Math.round(i * (arr.length - 1) / (m - 1))]);
  return out;
}
function pickFrames(frames, k) {
  const keys = frames.filter((f) => f.key), rest = frames.filter((f) => !f.key);
  const chosen = keys.length >= k ? uniform(keys, k) : keys.concat(uniform(rest, k - keys.length));
  return chosen.sort((a, b) => a.id - b.id);
}
function chunk(frames, per) {
  const groups = []; let g = null;
  for (const f of frames) { if (!g || g.length >= per || g[0].label !== f.label) { g = []; groups.push(g); } g.push(f); }
  return groups;
}
function planImages(frames, maxImages, tileMode) {
  const n = frames.length;
  if (!n) return { groups: [], tiled: false, used: 0 };
  const tiled = tileMode === "on" || (tileMode === "auto" && n > maxImages);
  const per = tiled ? 4 : 1;
  let k = Math.min(n, maxImages * per);
  for (; ;) {
    const groups = chunk(pickFrames(frames, k), per);
    if (groups.length <= maxImages || k <= 1) return { groups, tiled, used: groups.reduce((s, g) => s + g.length, 0) };
    k -= Math.max(1, groups.length - maxImages);
  }
}
function updatePlan() {
  const ready = state.frames.filter((f) => f.blob);
  if (!ready.length) { $("#plan").textContent = ""; return; }
  const p = planImages(ready, settings.maxImages, settings.tile);
  $("#plan").textContent = `${ready.length} captured → ${p.used} sent as ${p.groups.length} image${p.groups.length === 1 ? "" : "s"}${p.tiled ? " (2×2)" : ""}`;
}
// One frame as Claude sees it: cropped to the viewport, text blacked out.
async function frameCanvas(f, maxSide) {
  const bmp = await bitmapOf(f), r = autoCrop(f.sizeKey);
  const sx = r.x * bmp.width, sy = r.y * bmp.height, sw = r.w * bmp.width, sh = r.h * bmp.height;
  const s = maxSide ? Math.min(1, maxSide / Math.max(sw, sh)) : 1;
  const c = document.createElement("canvas"); c.width = Math.round(sw * s); c.height = Math.round(sh * s);
  const x = c.getContext("2d"); x.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height); bmp.close?.();
  x.fillStyle = "#000";
  for (const b of state.masks.get(f.sizeKey)?.boxes || []) {
    const bx = (b.x - r.x) / r.w, by = (b.y - r.y) / r.h, bw = (b.x2 - b.x) / r.w, bh = (b.y2 - b.y) / r.h;
    x.fillRect(bx * c.width, by * c.height, bw * c.width, bh * c.height);
  }
  return c;
}
function burnLabel(ctx, text, x, y, scale) {
  ctx.font = `600 ${Math.round(15 * scale)}px Consolas, ui-monospace, monospace`;
  const w = ctx.measureText(text).width + 10 * scale, h = 20 * scale;
  ctx.fillStyle = "rgba(0,0,0,.8)"; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffd34d"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 5 * scale, y + h / 2 + 1);
}
async function renderGroup(group, tiled) {
  let c;
  if (!tiled) {
    c = await frameCanvas(group[0], 1280);
    burnLabel(c.getContext("2d"), "#" + group[0].id, 4, 4, Math.max(0.8, c.width / 900));
  } else {
    const cell = 512; c = document.createElement("canvas"); c.width = c.height = cell * 2;
    const x = c.getContext("2d"); x.fillStyle = "#000"; x.fillRect(0, 0, c.width, c.height);
    const parts = await Promise.all(group.map((f) => frameCanvas(f, 1024)));
    parts.forEach((b, i) => {
      const ox = (i % 2) * cell, oy = Math.floor(i / 2) * cell, s = Math.min(cell / b.width, cell / b.height);
      const w = b.width * s, h = b.height * s;
      x.drawImage(b, ox + (cell - w) / 2, oy + (cell - h) / 2, w, h);
      burnLabel(x, "#" + group[i].id, ox + 4, oy + 4, 1);
    });
    x.strokeStyle = "#333"; x.lineWidth = 2; x.beginPath(); x.moveTo(cell, 0); x.lineTo(cell, c.height); x.moveTo(0, cell); x.lineTo(c.width, cell); x.stroke();
  }
  return c.toDataURL("image/jpeg", 0.9).split(",")[1];
}

/* ---------- prompt ---------- */
const SYSTEM = `You are assisting a physician by giving a provisional radiology read of a CT study. The physician captured the images from their PACS screen while scrolling, and will check everything you say against the images.

How the images were made:
- They are screen captures, not DICOM. Window/level is fixed as displayed. Hounsfield units cannot be measured. There is no scale bar, so any size you give is an estimate relative to anatomy and must be marked approximate.
- Slices were sampled while the physician scrolled at their own pace, so spacing between slices is irregular and some anatomy may be skipped. Order is capture order; scroll direction may change.
- Each slice carries a yellow label like #12 in its top-left corner. Some images are 2×2 grids of four slices; read each cell separately and cite each cell's own label.
- Patient identifiers were removed on the physician's computer before sending. Black rectangles are redacted on-screen text; ignore them. Placeholders such as [name], [date] and [removed] in the clinical details are redactions.
- If a window is not stated, identify it yourself from the appearance (soft tissue, lung, bone, brain, etc.).

How to read:
- Answer the clinical question first, then review every structure that is covered systematically.
- Describe only what you actually see. Do not infer findings from the history alone. If something is equivocal, say so and give your confidence.
- Cite the slice labels (for example #14, #15) that support every finding, so the physician can check it.
- Say plainly which regions were not covered or cannot be assessed on these captures (for example: windows not shown, slices skipped, phase unsuitable).
- Prefix any finding that would need urgent action with "CRITICAL:".

Write the read in Markdown with exactly these sections:
## Impression
A numbered list, most important first. One line each.
## Findings
Grouped by organ system or region with ### subheadings. Include pertinent negatives that matter for the clinical question.
## Differential diagnosis
A numbered list ordered by likelihood. For each: **diagnosis** — likelihood (high / moderate / low); features for; features against.
## Not assessed or limited
## Suggested next steps
## Confidence
One line: low, moderate or high, and why.`;

function clinicalText() {
  const v = (id) => $(id).value.trim();
  const hist = SWScrub.scrub(v("#cHist")).text, q = SWScrub.scrub(v("#cQ")).text;
  const lines = [];
  const age = v("#cAge"), sex = v("#cSex");
  if (age || sex) lines.push(`- Patient: ${[age && "age " + age, sex].filter(Boolean).join(", ")}`);
  lines.push(`- Study: ${v("#cStudy")}`);
  lines.push(`- Contrast phase: ${v("#cPhase")}`);
  lines.push(`- History: ${hist || "not given"}`);
  lines.push(`- Clinical question: ${q || "not given"}`);
  return lines.join("\n");
}
async function buildFirstMessage() {
  const ready = state.frames.filter((f) => f.blob);
  const p = planImages(ready, settings.maxImages, settings.tile);
  setStatus("Loading text recognition…");
  await buildMasks(p.groups.flat(), (d, t) => setStatus(`Removing on-screen text on this PC (${d} of ${t})…`));
  const counts = {}; p.groups.flat().forEach((f) => counts[f.label] = (counts[f.label] || 0) + 1);
  const keys = ready.filter((f) => f.key).map((f) => "#" + f.id);
  const clin = clinicalText();
  const content = [{ type: "text", text:
`Clinical details:
${clin}

Capture: ${ready.length} slices were captured from the screen; ${p.used} are sent here as ${p.groups.length} image${p.groups.length === 1 ? "" : "s"}${p.tiled ? " (2×2 grids, cells read left to right, top to bottom)" : ""}.
Windows tagged by the physician: ${Object.entries(counts).map(([k, n]) => `${k === "Auto" ? "untagged" : k} ${n}`).join(", ")}.
${keys.length ? `Key slices the physician flagged for attention: ${keys.join(", ")}.` : "No key slices flagged."}${window.liveNotesText?.() ? `

Notes you made while watching live (provisional; re-check every one against the images below):
${window.liveNotesText()}` : ""}` }];
  const sentImgs = [];
  let i = 0;
  for (const g of p.groups) {
    i++; setStatus(`Preparing image ${i} of ${p.groups.length}…`);
    const data = await renderGroup(g, p.tiled);
    sentImgs.push(data);
    content.push({ type: "text", text: `Image ${i}: window ${g[0].label === "Auto" ? "untagged" : g[0].label}; slice${g.length > 1 ? "s" : ""} ${g.map((f) => "#" + f.id).join(", ")}.` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  }
  content.push({ type: "text", text: "Give your read now, using the required sections." });
  showSent(clin, sentImgs);
  return content;
}
function showSent(clin, imgs) {
  $("#sentWrap").hidden = false;
  $("#sentSum").textContent = `What Claude received (${imgs.length} image${imgs.length === 1 ? "" : "s"} and this text)`;
  $("#sentText").textContent = clin;
  const g = $("#sentGrid"); g.textContent = "";
  for (const d of imgs) {
    const im = document.createElement("img"); im.src = "data:image/jpeg;base64," + d; im.alt = "Image sent to Claude";
    im.onclick = () => openLightbox(null, im.src); g.append(im);
  }
}

/* ---------- calling Claude ---------- */
function friendlyError(e) {
  const A = window.Anthropic;
  if (A && e instanceof A.APIUserAbortError) return "Stopped.";
  if (A && e instanceof A.AuthenticationError) return "The API key was rejected. Check it in Settings.";
  if (A && e instanceof A.PermissionDeniedError) return "This API key isn't allowed to use that model. Pick another model in Settings or check the key.";
  if (A && e instanceof A.RateLimitError) return "Rate limit reached. Wait a minute and try again.";
  if (A && e instanceof A.BadRequestError) return "The request was rejected: " + (e.error?.error?.message || e.message);
  if (A && e instanceof A.APIConnectionError) return "Couldn't reach api.anthropic.com. Check the internet connection; a hospital network may block it.";
  if (A && e instanceof A.APIError) return `Claude API error ${e.status ?? ""}: ${e.error?.error?.message || e.message}`;
  return "Something went wrong: " + (e?.message || e);
}
// Optional request features (refusal fallback, prompt caching, reasoning summaries). If the API turns one down
// for this account or model, retry once without them and keep using the basic request from then on.
const apiCompat = { minimal: false };
function basicParams(p) {
  const q = { ...p };
  delete q.betas; delete q.fallbacks; delete q.cache_control;
  if (q.thinking) q.thinking = { type: "adaptive" };
  return q;
}
async function streamWithFallback(client, params, signal, onEvent) {
  const run = async (p) => {
    const st = client.beta.messages.stream(p, { signal });
    for await (const ev of st) onEvent?.(ev);
    const msg = await st.finalMessage();
    addUsage(msg);
    return msg;
  };
  if (!apiCompat.minimal) {
    try { return await run(params); }
    catch (e) {
      const A = window.Anthropic;
      const optional = A && e instanceof A.BadRequestError && /beta|fallback|cache_control|display|thinking|unknown|not supported|not permitted|extra inputs/i.test(e.message);
      if (!optional) throw e;
      console.warn("Retrying without optional API features:", e.message);
      apiCompat.minimal = true;
    }
  }
  return run(basicParams(params));
}

async function callClaude(messages, onText) {
  const client = new window.Anthropic({ apiKey: settings.key, dangerouslyAllowBrowser: true, maxRetries: 2 });
  state.ctl = new AbortController();
  let text = "", thinking = "";
  const msg = await streamWithFallback(client, {
    model: settings.model,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: settings.effort },
    cache_control: { type: "ephemeral" },
    system: SYSTEM,
    messages,
  }, state.ctl.signal, (ev) => {
    if (ev.type === "content_block_delta") {
      if (ev.delta.type === "text_delta") { text += ev.delta.text; onText(text); setStatus(""); }
      else if (ev.delta.type === "thinking_delta") { thinking += ev.delta.thinking; $("#thinkWrap").hidden = false; $("#think").textContent = thinking; }
    }
  });
  return { msg, text };
}

/* ---------- cost of this study ---------- */
// $ per million tokens: [input, output, cache read]. Cache writes bill at 1.25× input.
const PRICES = { "claude-opus-5-5": [4, 20, 0.2], "claude-fable-5-1": [10, 50, 0.25], "claude-sonnet-5-5": [2, 10, 0.2] };
const usage = { cost: 0, calls: 0 };
function addUsage(msg) {
  const u = msg?.usage; if (!u) return;
  const p = PRICES[msg.model] || PRICES[settings.model] || PRICES["claude-opus-5-5"];
  usage.cost += ((u.input_tokens || 0) * p[0] + (u.cache_creation_input_tokens || 0) * p[0] * 1.25 + (u.cache_read_input_tokens || 0) * p[2] + (u.output_tokens || 0) * p[1]) / 1e6;
  usage.calls++;
  renderCost();
}
function renderCost() { $("#cost").textContent = usage.calls ? `≈ $${usage.cost < 0.01 ? usage.cost.toFixed(3) : usage.cost.toFixed(2)} this study` : ""; }
function resetUsage() { usage.cost = 0; usage.calls = 0; renderCost(); }
function resetReport() {
  state.convo = null; state.qa = []; state.reportMd = ""; showErr("");
  $("#think").textContent = ""; $("#thinkWrap").hidden = true; $("#fuForm").hidden = true; $("#sentWrap").hidden = true;
  $("#report").innerHTML = '<p class="report-empty">Press Record, scroll through the study, then press Stop. The read appears here, and each finding links to the slices it is based on.</p>';
}
async function analyze() {
  if (state.busy || !state.frames.some((f) => f.blob)) return;
  if (!window.Anthropic) { showErr("The Claude client failed to load. Reinstall SliceWatch."); return; }
  if (!settings.key) { openSettings(); toast("Add your Anthropic API key, then press Read study."); return; }
  if (state.capturing) setCapturing(false);
  // wait for the last frames to finish encoding
  for (let i = 0; i < 20 && state.frames.some((f) => !f.blob); i++) await new Promise((r) => setTimeout(r, 50));
  window.beforeFinalRead?.();
  resetReport();
  state.busy = true; syncButtons();
  $("#report").innerHTML = "";
  try {
    const content = await buildFirstMessage();
    setStatus("Claude is reviewing the slices… (usually 30–120 s)");
    const messages = [{ role: "user", content }];
    const { msg, text } = await callClaude(messages, (t) => { state.reportMd = t; renderReport(); });
    finishTurn(messages, msg, text);
  } catch (e) { console.error(e); showErr(friendlyError(e)); }
  finally { state.busy = false; setStatus(""); syncButtons(); }
}
function finishTurn(messages, msg, text) {
  if (msg.stop_reason === "refusal") { showErr("Claude declined this request. Try rephrasing the clinical details or use another model."); return; }
  if (msg.stop_reason === "max_tokens") showErr("The read was cut off at the length limit. Ask a follow-up to continue.");
  if (!text.trim()) { showErr("Claude returned no text. Try again."); return; }
  messages.push({ role: "assistant", content: msg.content });
  state.convo = messages; $("#fuForm").hidden = false;
}
async function followUp(q) {
  if (!state.convo || state.busy || !q) return;
  q = SWScrub.scrub(q).text;
  state.busy = true; syncButtons(); showErr("");
  const entry = { q, a: "" }; state.qa.push(entry); renderReport();
  setStatus("Thinking…");
  const messages = state.convo.concat([{ role: "user", content: q }]);
  try {
    const { msg, text } = await callClaude(messages, (t) => { entry.a = t; renderReport(); });
    finishTurn(messages, msg, text);
  } catch (e) { showErr(friendlyError(e)); state.qa.pop(); renderReport(); }
  finally { state.busy = false; setStatus(""); syncButtons(); }
}

/* ---------- report rendering ---------- */
function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/CRITICAL:?/g, (m) => `<span class="crit">${m}</span>`);
  s = s.replace(/(^|[^&\w])#(\d{1,4})\b/g, (m, p, n) => `${p}<button type="button" class="sref" data-id="${n}">#${n}</button>`);
  return s;
}
function md(src) {
  const lines = src.replace(/\r/g, "").split("\n"); const out = []; let list = null, para = [];
  const flushP = () => { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
  const closeL = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], l = raw.trim();
    if (!l) { flushP(); closeL(); continue; }
    let m;
    if (/^\|.*\|$/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      flushP(); closeL();
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let h = '<div class="tbl"><table><thead><tr>' + cells(l).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
      i += 2; while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { h += "<tr>" + cells(lines[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>"; i++; }
      i--; out.push(h + "</tbody></table></div>"); continue;
    }
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { flushP(); closeL(); const lv = m[1].length; out.push(lv <= 2 ? `<h2 class="r">${inline(m[2])}</h2>` : lv === 3 ? `<h3>${inline(m[2])}</h3>` : `<h4>${inline(m[2])}</h4>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(l)) { flushP(); closeL(); out.push("<hr>"); continue; }
    if ((m = l.match(/^[-*•]\s+(.*)$/))) { flushP(); if (list !== "ul") { closeL(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = l.match(/^(\d+)[.)]\s+(.*)$/))) { flushP(); if (list !== "ol") { closeL(); out.push(`<ol start="${m[1]}">`); list = "ol"; } out.push(`<li>${inline(m[2])}</li>`); continue; }
    if (list && /^\s{2,}/.test(raw)) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, " " + inline(l) + "</li>"); continue; }
    closeL(); para.push(l);
  }
  flushP(); closeL(); return out.join("\n");
}
let repQueued = false;
function renderReport() {
  if (repQueued) return; repQueued = true;
  requestAnimationFrame(() => {
    repQueued = false;
    let h = md(state.reportMd);
    for (const e of state.qa) h += `<p class="qa-q">Q: ${esc(e.q)}</p>` + (e.a ? md(e.a) : '<p class="report-empty">…</p>');
    $("#report").innerHTML = h || '<p class="report-empty">Waiting for the first words…</p>';
  });
}
$("#report").addEventListener("click", (e) => { const b = e.target.closest(".sref"); if (b) openLightbox(+b.dataset.id); });

/* ---------- clinical details from a screenshot ---------- */
async function readClinicalScreenshot(blob) {
  const msg = $("#clinMsg");
  msg.hidden = false; msg.className = "clin-msg"; msg.textContent = "Reading the screenshot on this PC…";
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.max(1, Math.min(3, 2200 / bmp.width));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    const data = await OCR.read(c);
    const raw = (data.text || "").trim();
    if (raw.replace(/\W/g, "").length < 8) { msg.className = "clin-msg warn"; msg.textContent = "No readable text found in that image. Try a sharper screenshot, or type the details."; return; }
    const r = SWScrub.scrub(raw);
    const g = SWScrub.guessFields(r.text);
    const h = $("#cHist");
    h.value = (h.value.trim() ? h.value.trim() + "\n\n" : "") + r.text;
    if (r.age) $("#cAge").value = r.age;
    if (r.sex) $("#cSex").value = r.sex;
    if (g.study) $("#cStudy").value = g.study;
    if (g.phase) $("#cPhase").value = g.phase;
    if (g.question && !$("#cQ").value.trim()) $("#cQ").value = g.question;
    const rm = r.removed, parts = [];
    if (rm.names) parts.push(`${rm.names} name${rm.names > 1 ? "s" : ""}`);
    if (rm.dob) parts.push("date of birth");
    if (rm.ids) parts.push(`${rm.ids} ID number${rm.ids > 1 ? "s" : ""}`);
    if (rm.contact) parts.push("contact details");
    if (rm.dates) parts.push(`${rm.dates} other date${rm.dates > 1 ? "s" : ""}`);
    msg.className = "clin-msg warn";
    msg.textContent = `Filled in from the screenshot. Removed: ${parts.length ? parts.join(", ") : "nothing that looked identifying"}. The image itself is not sent. Glance over the History text for anything identifying that was missed.`;
  } catch (e) {
    console.error(e);
    msg.className = "clin-msg warn"; msg.textContent = "Couldn't read that image: " + (e?.message || e);
  }
}
const drop = $("#drop");
drop.onclick = () => $("#clinFile").click();
drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#clinFile").click(); } };
$("#clinFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) readClinicalScreenshot(f); };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/")); if (f) readClinicalScreenshot(f); };
document.addEventListener("paste", (e) => {
  if (e.target.closest?.("input,textarea")) return;
  const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (it) { e.preventDefault(); readClinicalScreenshot(it.getAsFile()); }
});

/* ---------- settings ---------- */
function openSettings() {
  $("#sKey").value = settings.key; $("#sRemember").checked = settings.remember; $("#sAuto").checked = settings.autoRead; $("#sLive").checked = settings.live !== false;
  $("#sModel").value = settings.model; $("#sEffort").value = settings.effort;
  $("#sMax").value = settings.maxImages; $("#sTile").value = settings.tile; $("#sThorough").checked = settings.thorough;
  $("#sTestMsg").textContent = "";
  $("#dlgSettings").showModal();
}
$("#dlgSettings").addEventListener("close", () => {
  if ($("#dlgSettings").returnValue !== "save") return;
  settings.key = $("#sKey").value.trim(); settings.remember = $("#sRemember").checked; settings.autoRead = $("#sAuto").checked;
  settings.model = $("#sModel").value; settings.effort = $("#sEffort").value;
  settings.maxImages = Math.max(4, Math.min(100, parseInt($("#sMax").value, 10) || 40)); settings.tile = $("#sTile").value;
  settings.thorough = $("#sThorough").checked; settings.live = $("#sLive").checked;
  saveSettings(); syncButtons(); showSetup(); if (typeof renderLive === "function") renderLive(); toast("Settings saved.");
});

/* ---------- desktop app: screen picker and global hotkeys ---------- */
if (desktop) {
  desktop.onPickSource((sources) => new Promise((resolve) => {
    const grid = $("#pickGrid"); grid.textContent = "";
    for (const s of sources) {
      const b = document.createElement("button"); b.type = "button";
      const im = document.createElement("img"); im.src = s.thumb; im.alt = "";
      const sp = document.createElement("span"); sp.textContent = s.name;
      b.append(im, sp); b.onclick = () => { $("#dlgPick").close(); resolve(s.id); };
      grid.append(b);
    }
    $("#pickCancel").onclick = () => { $("#dlgPick").close(); resolve(null); };
    $("#dlgPick").onclose = () => resolve(null);
    $("#dlgPick").showModal();
  }));
  desktop.version?.().then((v) => { $(".brand small").textContent = `v${v} · CT second read from your screen`; });
  desktop.onUpdateReady?.((v) => {
    const t = $("#toast");
    t.innerHTML = `SliceWatch ${esc(v)} is ready. It installs when you close the app. <button class="btn small" id="btnUpd" type="button">Restart now</button>`;
    t.hidden = false; clearTimeout(toastT);
    $("#btnUpd").onclick = () => desktop.installUpdate();
  });
  desktop.onHotkey((name) => { if (name === "record") toggleRecord(); else if (name === "snap") snapKey(); });
  $("#hotkeyHint").innerHTML = "Press Record or <b>Ctrl+Shift+R</b> from anywhere, even while PACS has focus. <b>Ctrl+Shift+K</b> saves a key slice, <b>Ctrl+Shift+C</b> snaps the clinical details. Press Ctrl+Shift+R again to stop and read.";
}

/* ---------- wiring ---------- */
$("#btnSettings").onclick = openSettings;
$("#btnSetup").onclick = openSettings;
function showSetup() { $("#setup").hidden = !!settings.key; }
// A tiny request proves the key, billing and model access before a real study.
$("#sTest").onclick = async () => {
  const key = $("#sKey").value.trim(), msg = $("#sTestMsg");
  if (!key) { msg.textContent = "Paste a key first."; return; }
  msg.className = "hint"; msg.textContent = "Testing…"; $("#sTest").disabled = true;
  try {
    const client = new window.Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 0 });
    apiCompat.minimal = false;
    await streamWithFallback(client, {
      model: $("#sModel").value, max_tokens: 256, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "low" }, cache_control: { type: "ephemeral" },
      messages: [{ role: "user", content: "Reply with the single word OK." }],
    }, undefined);
    msg.textContent = "The key works with this model" + (apiCompat.minimal ? " (in basic mode: some optional features were turned off)" : "") + ". Press Save.";
  } catch (e) {
    msg.className = "hint warn";
    const A = window.Anthropic;
    msg.textContent = A && e instanceof A.AuthenticationError ? "That key was rejected. Copy it again from console.anthropic.com."
      : A && e instanceof A.APIError && /credit|billing|balance/i.test(e.message) ? "The key is valid but the account has no credit. Add credit under Billing."
      : friendlyError(e);
  } finally { $("#sTest").disabled = false; }
};
$("#btnRecord").onclick = toggleRecord;
$("#btnStop").onclick = stopSource;
$("#btnSnap").onclick = snapKey;
$("#btnClear").onclick = clearFrames;
$("#btnAnalyze").onclick = analyze;
$("#btnAbort").onclick = () => state.ctl?.abort();
$("#btnNew").onclick = () => {
  if (state.busy) state.ctl?.abort();
  if (state.capturing) setCapturing(false);
  clearFrames(); $("#clin").reset(); $("#clinMsg").hidden = true; resetReport(); resetUsage(); window.onNewStudy?.();
};
$("#fuForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#fuIn").value.trim(); $("#fuIn").value = ""; followUp(q); });
$("#sens").value = settings.sens; $("#sensVal").textContent = settings.sens;
$("#sens").oninput = () => { settings.sens = +$("#sens").value; $("#sensVal").textContent = settings.sens; saveSettings(); };
$("#fileIn").onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = "";
  const vid = files.find((f) => f.type.startsWith("video/"));
  if (vid) { loadVideoFile(vid); toast("Recording loaded. Press Play & capture."); }
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  for (const f of imgs) await addImageFile(f);
  if (imgs.length) toast(`${imgs.length} slice image${imgs.length > 1 ? "s" : ""} added.`);
};
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input,textarea,select,dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " ") { if (state.mode) { e.preventDefault(); snapKey(); } }
  else if (e.key === "r" || e.key === "R") toggleRecord();
  else if (/^[1-9]$/.test(e.key)) { const w = WINDOWS[+e.key - 1]; if (w) { state.label = w; renderChips(); } }
});
window.addEventListener("beforeunload", (e) => { if (state.frames.length || state.convo) { e.preventDefault(); e.returnValue = ""; } });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => { });

renderChips(); updateCropHint(); renderStrip(); syncButtons(); showSetup();
window.__sw = { state, settings, planImages, md, autoCrop, buildFirstMessage, buildMasks, frameCanvas, readClinicalScreenshot, toggleRecord, OCR };
