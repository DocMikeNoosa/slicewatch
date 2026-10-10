# SliceWatch

A provisional, AI-assisted second read of a CT study, taken from your own PACS screen.

Press **Record**, scroll through the study, and press **Stop**. While you scroll, Claude keeps a working
impression and tells you what it needs to see next (a window, a region, a phase). When you stop, it writes a
full read: impression, findings by region, ranked differential, what it could not assess, next steps and
confidence. Every finding cites the slices it is based on, and you can click a citation to open that slice.

> SliceWatch is a personal decision-support tool, not a medical device. It can miss findings and can describe
> findings that are not there. Check every finding against the images yourself.

## Patient identifiers stay on your computer

- **Images.** SliceWatch keeps only the part of the screen that changes as you scroll (the image viewport),
  so worklists and banners are left out. All on-screen text inside it, such as name, date of birth, MRN and
  accession number, is found by text recognition running on your PC and blacked out before anything is sent.
- **Clinical details.** Snap the request from your screen (or paste a screenshot). The text is read on your PC.
  Names, dates of birth, ID numbers, addresses, phone numbers and other dates are removed. Age becomes a band
  (for example "60s") and sex is kept. The screenshot itself is never sent.
- **What gets sent.** Only to `api.anthropic.com`, with your own API key. The "What Claude received" panel
  shows exactly what was sent for each read.

## Install

**Windows app (recommended).** Download `SliceWatch-Setup-x.y.z.exe` from the Releases page and run it.
Windows may show a SmartScreen warning because the app is not code-signed: choose *More info → Run anyway*.
`SliceWatch-Portable-x.y.z.exe` runs without installing.

**Web version.** Open the GitHub Pages link in Chrome or Edge. Use *Install SliceWatch* in the address bar to
add it to your PC like an app. It also works offline after the first visit.

## First run

1. Open **Settings** and paste an Anthropic API key (console.anthropic.com → API keys). API use is billed
   separately from a Claude subscription.
2. **Clinical details:** press **Snap from screen**, drag a box around the request, and the fields fill in.
3. Press **Record**, choose the screen showing PACS, and scroll through the study. Press **Stop** for the read.

### Windows app hotkeys (work while PACS or the EMR has focus)

| Keys | Action |
| --- | --- |
| Ctrl+Shift+R | Start recording / stop and read |
| Ctrl+Shift+K | Save a key slice |
| Ctrl+Shift+C | Snap clinical details from the screen |

## Layout

- `web/`: the app (plain HTML, CSS and JavaScript). `web/vendor/` holds Tesseract.js (on-device text
  recognition) and the Anthropic SDK, copied there by `npm run vendor`.
- `desktop/`: the Electron shell for the Windows app (screen picker, global hotkeys).
- `tests/`: `npm test` checks identifier removal.
- `.github/workflows/release.yml`: builds the Windows installer, installs and launches it on a Windows runner,
  and attaches it to the release when a `v*` tag is pushed.
