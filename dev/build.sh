#!/usr/bin/env bash
# 打包上架用的 zip：只含扩展本体，不含 dev/ 和 .git
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
mkdir -p dev/dist
OUT="dev/dist/clearsky-translate-$VER.zip"
rm -f "$OUT"
zip -qr "$OUT" manifest.json background.js privacy.html _locales icons lib content popup options -x "*.DS_Store"
echo "已生成 $OUT"
