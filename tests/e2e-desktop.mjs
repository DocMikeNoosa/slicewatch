// Windows app (or the desktop shell in development), end to end.
// SLICEWATCH_EXE=path\to\SliceWatch.exe tests the installed app; without it, runs desktop/ with its Electron.
import path from "path";
import { fileURLToPath } from "url";
import { _electron } from "playwright";
import { installFakeScreens, mockClaude, setKey, runStudy, check } from "./flow.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.env.SLICEWATCH_EXE;
const app = await _electron.launch(exe
  ? { executablePath: exe, timeout: 90000 }
  : { executablePath: path.join(repo, "desktop", "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron"), args: [path.join(repo, "desktop"), "--no-sandbox"], timeout: 90000 });
let failed = false;
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => window.__sw && window.Tesseract && window.Anthropic, null, { timeout: 30000 });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  console.log("== desktop app ==");
  check(page.url().startsWith("app://slicewatch/"), "app loads from inside the package");
  check(await page.evaluate(() => !!window.swDesktop), "desktop bridge available");
  console.log("  version", await page.evaluate(() => window.swDesktop.version()));

  const shots = await page.evaluate(() => window.swDesktop.screenshot().then((s) => s.map((x) => x.url.length)));
  check(shots.length >= 1 && shots[0] > 5000, `real screenshot of the desktop (${shots.length} screen(s))`);

  // Real screen capture through the app's own picker.
  const pending = page.evaluate(async () => {
    try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); const st = s.getVideoTracks()[0].getSettings(); s.getTracks().forEach((t) => t.stop()); return `${st.width}x${st.height}`; }
    catch (e) { return "ERR " + e.name + " " + e.message; }
  });
  const picked = await Promise.race([
    page.waitForSelector("#dlgPick[open] .pick-grid button", { timeout: 15000 }).then(async (b) => { await b.click(); return "picker"; }).catch(() => "no picker"),
    pending.then(() => "auto"),
  ]);
  const res = await pending;
  check(!res.startsWith("ERR"), `real screen capture works (${picked}, ${res})`);

  const reqs = await mockClaude(page);
  await installFakeScreens(page, { big: false });
  await setKey(page);
  await runStudy(page, reqs, { desktop: true });
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
} catch (e) { failed = true; console.error(e.message); }
await app.evaluate(({ app }) => app.exit(0)).catch(() => { });
console.log(failed ? "\nDESKTOP E2E FAILED" : "\nDESKTOP E2E PASSED");
process.exit(failed ? 1 : 0);
