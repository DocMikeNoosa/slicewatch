#!/bin/sh
# Copies third-party runtime files into web/vendor. Run after npm install.
set -e
cd "$(dirname "$0")/.."
npx esbuild scripts/sdk-entry.js --bundle --minify --format=iife --platform=browser --outfile=web/vendor/anthropic-sdk.js --log-level=warning
cp node_modules/tesseract.js/dist/tesseract.min.js node_modules/tesseract.js/dist/worker.min.js web/vendor/tesseract/
cp node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js web/vendor/tesseract/core/
cp node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz web/vendor/tesseract/lang/
cp node_modules/tesseract.js/LICENSE.md web/vendor/tesseract/LICENSE.md 2>/dev/null || cp node_modules/tesseract.js/LICENSE web/vendor/tesseract/LICENSE
echo vendor ok
