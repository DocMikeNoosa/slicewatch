"use strict";
/* Two helpers built on app.js:
   1. Live watching: while recording, Claude looks at each batch of new slices and keeps a working read,
      and tells the physician what it needs to see next.
   2. Snap from screen: take a screenshot, drag a box around the clinical details, read them on this PC. */

/* ---------- 1. live watching ---------- */
const LIVE_SYSTEM = `You are watching a physician scroll through a CT study on their PACS screen, in real time, and keeping working notes toward a diagnosis.

How the images were made:
- Screen captures, not DICOM. Window/level is fixed as displayed; no Hounsfield units; sizes are estimates only.
- Each slice has a yellow label like #12 in its top-left corner. Some images are 2×2 grids of four slices; cite each cell's own label.
- Patient identifiers were removed before sending. Black rectangles are redacted on-screen text; ignore them.

Each turn you get only the slices captured since your last look, plus your own notes so far. Update the notes:
- Keep earlier findings unless the new slices change them. Describe only what you actually see, and cite slice labels.
- "critical": anything that needs urgent action, or an empty list.
- "requests": at most 3 short, specific instructions to the physician about what to show you next to settle the diagnosis, such as a window to switch to, a region to scroll through slowly, a series or phase to open, or slices to go back to. Empty when nothing more is needed.
- "coverage": the anatomy and windows seen so far, in a few words.
Be brief. These notes are shown on screen while the physician scrolls.`;

const LIVE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["working_impression", "critical", "findings", "differential", "coverage", "requests"],
  properties: {
    working_impression: { type: "string" },
    critical: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: { type: "string" } },
    differential: { type: "array", items: { type: "string" } },
    coverage: { type: "string" },
    requests: { type: "array", items: { type: "string" } },
  },
};

const live = { notes: null, lastId: 0, lastAt: 0, updatedAt: 0, inFlight: false, ctl: null, seen: 0, err: "", pending: 0, noFormat: false, lastAsk: "", ticker: null, off: false };
settings.live = store.get("live") !== "0";

function liveReset() {
  live.ctl?.abort();
  Object.assign(live, { notes: null, lastId: 0, lastAt: 0, updatedAt: 0, inFlight: false, ctl: null, seen: 0, err: "", pending: 0, lastAsk: "", off: false });
  renderLive();
}
function liveActive() { return settings.live && !live.off && !!settings.key && !!window.Anthropic; }

function maybeLive() {
  if (!state.capturing || live.inFlight || !liveActive()) return;
  const fresh = state.frames.filter((f) => f.blob && f.id > live.lastId);
  if (state.frames.length < 6 || !fresh.length) return;
  const due = fresh.length >= 8 || (fresh.length >= 2 && Date.now() - live.lastAt > 15000);
  if (due) liveUpdate(fresh);
}

function parseJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch { }
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { try { return JSON.parse(m[1]); } catch { } }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { } }
  return null;
}

async function liveUpdate(fresh) {
  live.inFlight = true; live.ctl = new AbortController();
  const pick = uniform(fresh, Math.min(8, fresh.length));
  live.lastId = Math.max(...fresh.map((f) => f.id));
  live.pending = pick.length;
  renderLive();
  try {
    await buildMasks(pick, null, 2);
    const groups = chunk(pick, 4);
    const content = [{ type: "text", text:
`Clinical details:
${clinicalText()}

Your working notes so far:
${live.notes ? JSON.stringify(live.notes, null, 1) : "None yet. This is your first look."}

Slices captured so far: ${state.frames.length}. New slices follow.` }];
    for (const g of groups) {
      const data = await renderGroup(g, g.length > 1);
      content.push({ type: "text", text: `Window ${g[0].label === "Auto" ? "untagged" : g[0].label}; slice${g.length > 1 ? "s" : ""} ${g.map((f) => "#" + f.id).join(", ")}.` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    }
    content.push({ type: "text", text: "Return your updated working notes as JSON with the keys working_impression, critical, findings, differential, coverage and requests." });
    const notes = await askLive(content);
    if (!notes || typeof notes.working_impression !== "string") throw new Error("Claude's live notes could not be read. The full read at Stop is unaffected.");
    for (const k of ["critical", "findings", "differential", "requests"]) if (!Array.isArray(notes[k])) notes[k] = [];
    live.notes = notes; live.seen += pick.length; live.updatedAt = Date.now(); live.err = "";
    notifyAsk(notes);
  } catch (e) {
    const A = window.Anthropic;
    if (A && e instanceof A.APIUserAbortError) { /* stopped on purpose */ }
    else {
      console.error(e);
      live.err = e instanceof Error && !(A && e instanceof A.APIError) ? e.message : friendlyError(e);
      if (A && (e instanceof A.AuthenticationError || e instanceof A.PermissionDeniedError)) live.off = true;
    }
  } finally {
    live.inFlight = false; live.pending = 0; live.lastAt = Date.now(); live.ctl = null;
    renderLive();
    setTimeout(maybeLive, 0);
  }
}

async function askLive(content) {
  const client = new window.Anthropic({ apiKey: settings.key, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const run = async (useFormat) => {
    const output_config = { effort: "low" };
    if (useFormat) output_config.format = { type: "json_schema", schema: LIVE_SCHEMA };
    const msg = await streamWithFallback(client, {
      model: settings.model, max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      thinking: { type: "adaptive" }, output_config,
      system: LIVE_SYSTEM, messages: [{ role: "user", content }],
    }, live.ctl.signal);
    if (msg.stop_reason === "refusal") throw new Error("Claude declined to comment on these slices.");
    return parseJson(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  };
  if (!live.noFormat) {
    try { return await run(true); }
    catch (e) {
      // If this model or account does not accept structured output, ask for JSON in plain text instead.
      if (window.Anthropic && e instanceof window.Anthropic.BadRequestError && /format|output_config|schema/i.test(e.message)) live.noFormat = true;
      else throw e;
    }
  }
  return run(false);
}

function ago(t) { const s = Math.round((Date.now() - t) / 1000); return s < 5 ? "just now" : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`; }
function renderLive() {
  const box = $("#live");
  const show = settings.live && (state.capturing || live.inFlight || (live.notes && !state.reportMd && !state.busy) || (live.err && state.capturing));
  box.hidden = !show;
  if (!show) return;
  const meta = [];
  if (live.inFlight) meta.push(`looking at ${live.pending} new slice${live.pending === 1 ? "" : "s"}…`);
  else if (live.updatedAt) meta.push(`updated ${ago(live.updatedAt)}`);
  if (live.seen) meta.push(`${live.seen} slices reviewed`);
  if (!live.notes && !live.inFlight && !live.err) meta.push(liveActive() ? "first look after 6 slices" : "add an API key in Settings to enable");
  $("#liveMeta").textContent = meta.join(" · ");
  const n = live.notes, ask = $("#liveAsk");
  if (n && n.requests.length) {
    ask.hidden = false;
    ask.innerHTML = "<b>Claude asks you to</b><ul>" + n.requests.map((r) => `<li>${inline(r)}</li>`).join("") + "</ul>";
  } else ask.hidden = true;
  let h = "";
  if (live.err) h += `<p class="err">${esc(live.err)}</p>`;
  if (n) {
    for (const c of n.critical) h += `<p><span class="crit">CRITICAL:</span> ${inline(c)}</p>`;
    h += `<p class="imp">${inline(n.working_impression)}</p>`;
    if (n.findings.length) h += "<ul>" + n.findings.map((f) => `<li>${inline(f)}</li>`).join("") + "</ul>";
    if (n.differential.length) h += `<p class="muted">Differential so far: ${n.differential.map(inline).join("; ")}</p>`;
    if (n.coverage) h += `<p class="muted">Seen so far: ${inline(n.coverage)}</p>`;
  } else if (!live.err) h = '<p class="report-empty">Claude gives a working impression after the first few slices and updates it as you scroll.</p>';
  $("#liveBody").innerHTML = h;
}
$("#liveBody").addEventListener("click", (e) => { const b = e.target.closest(".sref"); if (b) openLightbox(+b.dataset.id); });
$("#liveAsk").addEventListener("click", (e) => { const b = e.target.closest(".sref"); if (b) openLightbox(+b.dataset.id); });

// When Claude asks for something while PACS has focus, show a system notification so the request is not missed.
function notifyAsk(n) {
  const text = (n.critical.length ? "CRITICAL: " + n.critical[0] + "\n" : "") + n.requests.join("\n");
  if (!text || text === live.lastAsk) return;
  live.lastAsk = text;
  if (document.hasFocus() || !("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification(n.critical.length ? "SliceWatch: critical finding" : "SliceWatch: Claude asks", { body: text.slice(0, 240), silent: false }); } catch { }
}

// Hooks into app.js
window.onFrameReady = () => maybeLive();
window.onCaptureChange = (on) => {
  if (on) {
    if (!live.notes && !live.lastId) liveReset();
    if ("Notification" in window && Notification.permission === "default" && settings.live) Notification.requestPermission().catch(() => { });
    clearInterval(live.ticker); live.ticker = setInterval(() => { maybeLive(); renderLive(); }, 4000);
  } else { clearInterval(live.ticker); live.ticker = null; }
  renderLive();
};
window.beforeFinalRead = () => { live.ctl?.abort(); renderLive(); };
window.liveNotesText = () => live.notes ? JSON.stringify(live.notes, null, 1) : "";
window.onNewStudy = () => liveReset();

/* ---------- 2. snap clinical details from the screen ---------- */
const snap = { shots: [], idx: 0, img: null, sel: null, drag: null };

function canvasFromVideoFrame(v) {
  const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0); return c;
}
async function canvasFromUrl(url) {
  const im = new Image(); im.src = url; await im.decode();
  const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
  c.getContext("2d").drawImage(im, 0, 0); return c;
}
async function webScreenshot() {
  // Reuse the recording share if it is a whole screen; otherwise ask once for the screen with the notes on it.
  const track = state.stream?.getVideoTracks()[0];
  if (track && track.getSettings?.().displaySurface === "monitor" && video.videoWidth) return [{ name: "Shared screen", canvas: canvasFromVideoFrame(video) }];
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser can't take screenshots. Paste one with Ctrl+V instead.");
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const v = document.createElement("video"); v.muted = true; v.srcObject = stream; await v.play();
    await new Promise((r) => ("requestVideoFrameCallback" in v ? v.requestVideoFrameCallback(() => r()) : setTimeout(r, 300)));
    return [{ name: "Screenshot", canvas: canvasFromVideoFrame(v) }];
  } finally { stream.getTracks().forEach((t) => t.stop()); }
}
async function snapClinical(shots) {
  try {
    if (!shots) shots = desktop?.screenshot ? await desktop.screenshot() : await webScreenshot();
  } catch (e) {
    if (e?.name !== "NotAllowedError") toast("Couldn't take a screenshot: " + (e?.message || e));
    return;
  }
  if (!shots || !shots.length) { toast("No screen was captured."); return; }
  for (const s of shots) if (!s.canvas) s.canvas = await canvasFromUrl(s.url);
  snap.shots = shots; snap.idx = 0;
  const chips = $("#snapScreens"); chips.textContent = "";
  if (shots.length > 1) shots.forEach((s, i) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = s.name || `Screen ${i + 1}`;
    b.setAttribute("aria-pressed", String(i === 0));
    b.onclick = () => { snap.idx = i; [...chips.children].forEach((c, j) => c.setAttribute("aria-pressed", String(j === i))); showShot(); };
    chips.append(b);
  });
  $("#dlgSnap").showModal();
  showShot();
}
function showShot() {
  snap.img = snap.shots[snap.idx].canvas; snap.sel = null;
  const c = $("#snapCanvas"); c.width = snap.img.width; c.height = snap.img.height;
  drawSnap(); $("#snapRead").disabled = true;
}
function drawSnap() {
  const c = $("#snapCanvas"), x = c.getContext("2d"), s = snap.sel;
  x.drawImage(snap.img, 0, 0);
  if (!s) return;
  x.fillStyle = "rgba(0,0,0,.55)";
  x.fillRect(0, 0, c.width, s.y); x.fillRect(0, s.y + s.h, c.width, c.height - s.y - s.h); x.fillRect(0, s.y, s.x, s.h); x.fillRect(s.x + s.w, s.y, c.width - s.x - s.w, s.h);
  x.strokeStyle = "#e6b34c"; x.lineWidth = Math.max(2, c.width / 600); x.strokeRect(s.x, s.y, s.w, s.h);
}
{
  const c = $("#snapCanvas");
  const pt = (e) => { const b = c.getBoundingClientRect(); return { x: (e.clientX - b.left) * c.width / b.width, y: (e.clientY - b.top) * c.height / b.height }; };
  c.addEventListener("pointerdown", (e) => { c.setPointerCapture(e.pointerId); snap.drag = pt(e); });
  c.addEventListener("pointermove", (e) => {
    if (!snap.drag) return; const p = pt(e), d = snap.drag;
    snap.sel = { x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) }; drawSnap();
  });
  c.addEventListener("pointerup", () => {
    snap.drag = null;
    if (snap.sel && (snap.sel.w < 20 || snap.sel.h < 12)) { snap.sel = null; drawSnap(); }
    $("#snapRead").disabled = !snap.sel;
  });
}
function readSnap(whole) {
  const src = snap.img, s = whole || !snap.sel ? { x: 0, y: 0, w: src.width, h: src.height } : snap.sel;
  const c = document.createElement("canvas"); c.width = Math.round(s.w); c.height = Math.round(s.h);
  c.getContext("2d").drawImage(src, s.x, s.y, s.w, s.h, 0, 0, c.width, c.height);
  $("#dlgSnap").close();
  snap.shots = []; snap.img = null;
  readClinicalScreenshot(c);
}
$("#btnSnapClin").onclick = () => snapClinical();
$("#snapCancel").onclick = () => { $("#dlgSnap").close(); snap.shots = []; snap.img = null; };
$("#snapRead").onclick = () => readSnap(false);
$("#snapWhole").onclick = () => readSnap(true);
if (desktop?.onClinicalShot) {
  desktop.onClinicalShot((shots) => snapClinical(shots));
  $("#snapHint").textContent = "Or press Ctrl+Shift+C from any program, such as the EMR. Drag a box around the request and the fields fill in. The text is read on this PC; names, dates of birth, ID numbers, addresses and phone numbers are removed before anything is sent.";
}
renderLive();
window.__sw.live = live; window.__sw.snapClinical = snapClinical; window.__sw.readSnap = readSnap; window.__sw.snap = snap;
