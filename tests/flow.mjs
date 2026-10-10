// End-to-end study flow shared by the web test (Linux) and the installed-app test (Windows).
// A fake PACS screen and a fake EMR screen stand in for real ones, and Claude's replies are simulated,
// so the test checks SliceWatch's own work: capture, auto-crop, text blackout, scrubbing, live watching and the read.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REQUEST_PNG = path.join(here, "fixtures", "request.png");
export const IDENTIFIERS = ["SMITH", "Smith", "John", "Alan", "1958", "00482913", "Rose", "LS6", "0113", "943 476", "Patel", "Jane", "A99812345", "Elsewhere"];

export function check(cond, what) {
  if (!cond) throw new Error("FAILED: " + what);
  console.log("  ok  " + what);
}

// Replaces screen sharing in the page with two canvases: a PACS viewer (name/MRN/DOB overlays, 30 slices)
// and an EMR showing the request form. window.__emr picks which one the next share returns.
export async function installFakeScreens(page, { big = false } = {}) {
  const requestUrl = "data:image/png;base64," + fs.readFileSync(REQUEST_PNG).toString("base64");
  await page.evaluate(({ big, requestUrl }) => {
    const c = document.createElement("canvas"); c.width = 1600; c.height = 900;
    const x = c.getContext("2d"); window.__slice = 0; window.__emr = false;
    const noise = document.createElement("canvas"); noise.width = noise.height = 256;
    const nx = noise.getContext("2d"), nd = nx.createImageData(256, 256);
    for (let i = 0; i < nd.data.length; i += 4) { const v = Math.random() * 40; nd.data[i] = nd.data[i + 1] = nd.data[i + 2] = v; nd.data[i + 3] = 255; }
    nx.putImageData(nd, 0, 0);
    function draw() {
      const s = window.__slice;
      x.fillStyle = "#2b2f33"; x.fillRect(0, 0, 1600, 900);
      x.fillStyle = "#1d2125"; x.fillRect(0, 0, 330, 900);
      x.fillStyle = "#cfd6dc"; x.font = "15px sans-serif";
      ["SMITH, John Alan  CT HEAD", "JONES, Mary  CT CHEST", "BROWN, Peter  CT AP", "WILSON, Ann  CTPA"].forEach((t, i) => x.fillText(t, 14, 40 + i * 28));
      x.fillStyle = "#e8e8e8"; x.font = "16px sans-serif"; x.fillText("PACS Viewer  |  SMITH, John Alan  |  MRN 00482913", 350, 24);
      const vx = 350, vy = 40, vw = 1230, vh = 845;
      x.fillStyle = "#000"; x.fillRect(vx, vy, vw, vh);
      const cx = vx + vw / 2, cy = vy + vh / 2, R = big ? 2.2 : 1;
      x.save(); x.beginPath(); x.rect(vx, vy, vw, vh); x.clip();
      x.beginPath(); x.ellipse(cx, cy, (300 - s * 0.5 * 3) * R, (360 - s * 0.5 * 4) * R, 0, 0, 7); x.clip();
      x.fillStyle = "#c8c8c8"; x.fillRect(vx, vy, vw, vh);
      x.fillStyle = "#6e6e6e"; x.beginPath(); x.ellipse(cx, cy, (270 - s * 0.5 * 3) * R, (330 - s * 0.5 * 4) * R, 0, 0, 7); x.fill();
      x.globalAlpha = 0.6; for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) x.drawImage(noise, vx + i * 256, vy + j * 256);
      x.globalAlpha = 1; x.fillStyle = "#3a3a3a"; x.beginPath();
      x.ellipse(cx - 40, cy - 30 + s * 3, 30, 60, 0.3, 0, 7); x.ellipse(cx + 40, cy - 30 + s * 3, 30, 60, -0.3, 0, 7); x.fill();
      if (s >= 12 && s <= 16) { x.fillStyle = "#b5b5b5"; x.beginPath(); x.ellipse(cx + 150, cy - 80, 45, 30, 0.4, 0, 7); x.fill(); }
      x.restore();
      x.font = "14px monospace";
      x.fillStyle = "#f2e35c"; ["SMITH^JOHN^ALAN", "MRN: 00482913", "DOB: 14/03/1958  M", "Acc: A99812345"].forEach((t, i) => x.fillText(t, vx + 10, vy + 22 + i * 18));
      x.fillStyle = "#ffffff"; ["St Elsewhere General", "CT HEAD WO", "09-Oct-2026 14:32"].forEach((t, i) => x.fillText(t, vx + vw - 200, vy + 22 + i * 18));
      x.fillStyle = "#7cf27c"; x.fillText("Im: " + (s + 1) + "/30", vx + 10, vy + vh - 30); x.fillText("W: 80 L: 40", vx + 10, vy + vh - 12);
      x.fillStyle = "#ffffff"; x.fillText("5.0mm", vx + vw - 80, vy + vh - 12);
      requestAnimationFrame(draw);
    }
    draw();
    const emr = document.createElement("canvas"); emr.width = 1600; emr.height = 900;
    const im = new Image(); im.src = requestUrl;
    im.onload = () => { const e = emr.getContext("2d"); e.fillStyle = "#ddd"; e.fillRect(0, 0, 1600, 900); e.drawImage(im, 100, 0); setInterval(() => { e.fillStyle = "#ddd"; e.fillRect(0, 899, 1, 1); }, 100); };
    navigator.mediaDevices.getDisplayMedia = async () => (window.__emr ? emr : c).captureStream(30);
  }, { big, requestUrl });
}

// Simulated Claude: live calls get JSON notes, the full read gets a short report. Records every request body.
export async function mockClaude(page) {
  const reqs = [];
  await page.route("https://api.anthropic.com/**", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}"); reqs.push(body);
    const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
    const isLive = /watching a physician scroll/.test(body.system || "");
    const text = isLive
      ? JSON.stringify({ working_impression: "Possible right-sided hyperdensity at #13.", critical: [], findings: ["Rounded dense focus #13"], differential: ["Haemorrhage"], coverage: "Head", requests: ["Switch to bone window"] })
      : "## Impression\n1. CRITICAL: Hyperdense collection at #13, #14.\n\n## Findings\n### Brain\n- Simulated.\n\n## Confidence\nLow: simulated.";
    const sse = ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } })
      + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
      + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } })
      + ev("content_block_stop", { index: 0 })
      + ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 200 } })
      + ev("message_stop", {});
    if (isLive) await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" }, body: sse });
  });
  return reqs;
}

export async function setKey(page) {
  await page.evaluate(() => { window.__sw.settings.key = "sk-ant-test-simulated"; });
}

// Snap the clinical details from the fake EMR screen, then record 30 slices and stop. Checks everything sent.
export async function runStudy(page, reqs, { desktop = false } = {}) {
  console.log("clinical details from a screenshot");
  await page.evaluate(() => { window.__emr = true; });
  if (desktop) {
    // The desktop app photographs the real screen; hand it the fake EMR the way Ctrl+Shift+C delivers screenshots.
    const url = "data:image/png;base64," + fs.readFileSync(REQUEST_PNG).toString("base64");
    await page.evaluate(async (url) => {
      const im = new Image(); im.src = url; await im.decode();
      const c = document.createElement("canvas"); c.width = 1600; c.height = 900; const e = c.getContext("2d");
      e.fillStyle = "#ddd"; e.fillRect(0, 0, 1600, 900); e.drawImage(im, 100, 0);
      window.__sw.snapClinical([{ name: "Screen 1", url: c.toDataURL("image/png") }]);
    }, url);
  } else await page.click("#btnSnapClin");
  await page.waitForSelector("#dlgSnap[open]");
  await page.waitForTimeout(400);
  const cb = await page.locator("#snapCanvas").boundingBox();
  const P = (fx, fy) => [cb.x + cb.width * fx, cb.y + cb.height * fy];
  const [a1, b1] = P(110 / 1600, 70 / 900), [a2, b2] = P(1480 / 1600, 480 / 900);
  await page.mouse.move(a1, b1); await page.mouse.down(); await page.mouse.move(a2, b2, { steps: 6 }); await page.mouse.up();
  await page.click("#snapRead");
  await page.evaluate(() => { window.__emr = false; });
  await page.waitForFunction(() => /Filled in|No readable|Couldn't/.test(document.querySelector("#clinMsg").textContent), null, { timeout: 180000 });
  const hist = await page.inputValue("#cHist");
  check(/Filled in/.test(await page.textContent("#clinMsg")), "request text was read");
  check(IDENTIFIERS.every((w) => !hist.includes(w)), "no identifiers left in the History text");
  check(await page.inputValue("#cAge") === "60s" && await page.inputValue("#cSex") === "Male", "age band 60s and sex Male filled in");
  check(await page.inputValue("#cStudy") === "CT head non-contrast", "study type recognised");
  check(/haemorrhage/i.test(await page.inputValue("#cQ")), "clinical question filled in");

  console.log("record, scroll 30 slices, stop and read");
  await page.click("#btnRecord");
  await page.waitForFunction(() => window.__sw.state.capturing, null, { timeout: 20000 });
  for (let s = 0; s < 30; s++) { await page.evaluate((v) => { window.__slice = v; }, s); await page.waitForTimeout(350); }
  await page.waitForFunction(() => !window.__sw.live.inFlight, null, { timeout: 60000 });
  const live = reqs.filter((r) => /watching a physician/.test(r.system || ""));
  check(live.length >= 2, `Claude watched live (${live.length} updates)`);
  check(/Switch to bone window/.test(await page.textContent("#liveAsk")), "Claude's request shown while recording");
  await page.click("#btnRecord");
  await page.waitForFunction(() => !window.__sw.state.busy && document.querySelector("#report h2"), null, { timeout: 300000 });
  const frames = await page.evaluate(() => window.__sw.state.frames.length);
  check(frames >= 28, `slices captured (${frames} of 30)`);
  check(/CRITICAL/.test(await page.textContent("#report")), "read rendered with critical finding highlighted");
  check(/\$/.test(await page.textContent("#cost")), "cost estimate shown");

  const final = reqs.find((r) => !/watching a physician/.test(r.system || ""));
  const texts = JSON.stringify([...live, final].map((r) => r.messages[0].content.filter((c) => c.type === "text")));
  check(IDENTIFIERS.every((w) => !texts.includes(w)), "no identifiers in any text sent to Claude");
  check(texts.includes("Notes you made while watching live"), "final read includes the live notes");
  const imgs = [...live, final].flatMap((r) => r.messages[0].content.filter((c) => c.type === "image").map((c) => c.source.data));
  const pixels = await page.evaluate(async (datas) => {
    let worst = 0;
    for (const d of datas) {
      const im = new Image(); im.src = "data:image/jpeg;base64," + d; await im.decode();
      const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const x = c.getContext("2d"); x.drawImage(im, 0, 0);
      const px = x.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        const p = i / 4, X = p % c.width, Y = (p / c.width) | 0;
        const tiled = c.width === 1024 && c.height === 1024;   // 2×2 grids have a #label in each cell
        if (tiled ? (X % 512) < 90 && (Y % 512) < 40 : X < 130 && Y < 45) continue;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if ((r > 190 && g > 180 && b < 140) || (g > 190 && r < 170 && b < 170) || (r > 235 && g > 235 && b > 235)) n++;
      }
      worst = Math.max(worst, n);
    }
    return worst;
  }, imgs);
  check(pixels === 0, `no overlay-text pixels left in ${imgs.length} images sent (worst image: ${pixels})`);
  const ocr = await page.evaluate(async (datas) => {
    const w = await Tesseract.createWorker("eng", 1, { workerPath: "vendor/tesseract/worker.min.js", corePath: "vendor/tesseract/core", langPath: "vendor/tesseract/lang", gzip: true, cacheMethod: "none" });
    let all = ""; for (const d of datas.slice(0, 12)) all += (await w.recognize("data:image/jpeg;base64," + d)).data.text + "\n";
    await w.terminate(); return all;
  }, imgs);
  check(IDENTIFIERS.every((w) => !ocr.includes(w)), "independent text recognition finds no identifiers in the images sent");
}
