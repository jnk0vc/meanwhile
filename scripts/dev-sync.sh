#!/bin/sh
# 試運転用: plugins/meanwhile をこのセッションのmod読み込み用フォルダへ写す。
# 写した先だけ、サーバーをローカル(wrangler dev)に向け、マッチ開始を5秒にし、
# 開発用プレビューを有効にするdev.jsonを置く。リポジトリのファイルは変えない。
#
#   scripts/dev-sync.sh <dev-modsのセッションフォルダ>
set -eu
DEST="${1:?dev-modsのセッションフォルダを指定してください}/meanwhile"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DEST"
rsync -a --delete --exclude '.claude-plugin/types' "$ROOT/plugins/meanwhile/" "$DEST/"
node -e '
const fs = require("fs")
const path = process.argv[1] + "/.claude-plugin/plugin.json"
const manifest = JSON.parse(fs.readFileSync(path, "utf8"))
manifest.userConfig.server.default = "ws://127.0.0.1:8787"
manifest.userConfig.matchDelay.default = "5"
manifest.description = "[試運転] " + manifest.description
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n")
fs.writeFileSync(process.argv[1] + "/dev.json", JSON.stringify({ preview: true }) + "\n")
' "$DEST"
echo "synced to $DEST"
