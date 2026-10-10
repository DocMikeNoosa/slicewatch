// Web version, end to end, in Chromium. Run: npm run e2e:web   (CHROMIUM_PATH can point at a local Chromium)
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { installFakeScreens, mockClaude, setKey, runStudy } from "./flow.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".gz": "application/gzip", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = false;
for (const big of [false, true]) {
  console.log(`\n== web version, ${big ? "body fills the viewport, overlays on the image" : "body inside the viewport"} ==`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  try {
    const reqs = await mockClaude(page);
    await page.goto(url);
    await installFakeScreens(page, { big });
    await setKey(page);
    await runStudy(page, reqs);
    if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  } catch (e) { failed = true; console.error(e.message); }
  await page.close();
}
await browser.close(); server.close();
console.log(failed ? "\nWEB E2E FAILED" : "\nWEB E2E PASSED");
process.exit(failed ? 1 : 0);
