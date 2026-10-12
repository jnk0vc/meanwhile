// サイドカーを配布用にビルドし、plugins/meanwhile/sidecar/に書き出す。
//
//   npm run build
//
// 公式ディレクトリの検査は256KiBを超えるファイルを途中までしか読まないため、出力を1つにまとめず、
// エントリー(meanwhile-sidecar.mjs)と、分割したchunks/に分ける。esbuildは分割の大きさを指定
// できないので、依存モジュールをパスの順に一定の大きさまで詰めた「束」を一時的なエントリーとして足し、
// 分割の境目を作る。束のエントリー自体の出力は誰からも読み込まれないので書き出さない。
//
// - weriftは1ファイルにまとまったESM版(300KB超)ではなく、モジュールごとに分かれたCommonJS版を使う
// - debugパッケージは、何もしない代わり(src/shims/debug.ts)に差し替える
// - ライセンス表記は1つのmeanwhile-sidecar.mjs.LEGAL.txtにまとめる

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../plugins/meanwhile/sidecar')
const ENTRY = 'meanwhile-sidecar'
const LEGAL = `${ENTRY}.mjs.LEGAL.txt`
// 検査が全体を読むファイルの上限
const MAX_FILE = 256 * 1024
// 1つの束に詰める大きさ。束どうしが同じモジュールを読むと、そのモジュールは別のchunkに分かれるので小さめにする
const GROUP_SIZE = 120 * 1024

const options = {
  absWorkingDir: HERE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  alias: {
    debug: './src/shims/debug.ts',
    werift: './node_modules/werift/lib/webrtc/src/index.js',
  },
  // CommonJSのモジュールがNodeの組み込みモジュールをrequireできるようにする
  banner: { js: "import { createRequire as __mwRequire } from 'node:module'; const require = __mwRequire(import.meta.url);" },
  footer: { js: `/*! For license information please see sidecar/${LEGAL} */` },
  logLevel: 'warning',
}

/** 依存モジュールを、出力での大きさをもとにパスの順で束に分ける */
async function groupModules() {
  const { metafile } = await build({ ...options, entryPoints: ['src/main.ts'], outfile: 'probe.mjs', write: false, metafile: true })
  const inputs = Object.entries(Object.values(metafile.outputs)[0].inputs)
    .filter(([path]) => path.includes('node_modules/'))
    .sort(([a], [b]) => a.localeCompare(b))
  const groups = [[]]
  let size = 0
  for (const [path, { bytesInOutput }] of inputs) {
    if (size + bytesInOutput > GROUP_SIZE && groups.at(-1).length > 0) {
      groups.push([])
      size = 0
    }
    groups.at(-1).push(resolve(HERE, path))
    size += bytesInOutput
  }
  return groups
}

/** 同じ表記を1度だけ残して、ライセンス表記をつなぐ */
function mergeLegal(texts) {
  const blocks = new Set()
  for (const text of texts) {
    for (const block of text.replace(/^Bundled license information:\n\n/, '').split(/\n{2,}/)) {
      if (block.trim()) blocks.add(block.trimEnd())
    }
  }
  return `Bundled license information:\n\n${[...blocks].join('\n\n')}\n`
}

const groups = await groupModules()
const work = mkdtempSync(join(tmpdir(), 'meanwhile-build-'))
try {
  const entryPoints = { [ENTRY]: 'src/main.ts' }
  groups.forEach((paths, i) => {
    const file = join(work, `group-${i}.js`)
    writeFileSync(file, paths.map((path, j) => `export * as m${j} from ${JSON.stringify(path)}`).join('\n'))
    entryPoints[`groups/${i}`] = file
  })
  const { outputFiles } = await build({
    ...options,
    entryPoints,
    splitting: true,
    outdir: OUT,
    chunkNames: 'chunks/[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    legalComments: 'external',
    write: false,
  })

  const kept = outputFiles.filter(file => !relative(OUT, file.path).startsWith('groups/'))
  const code = kept.filter(file => !file.path.endsWith('.LEGAL.txt'))
  const tooLarge = code.filter(file => file.contents.byteLength > MAX_FILE)
  if (tooLarge.length > 0) {
    const names = tooLarge.map(file => `${relative(OUT, file.path)} (${file.contents.byteLength} bytes)`).join(', ')
    throw new Error(`256KiBを超えるファイルがあります: ${names}。GROUP_SIZEを小さくしてください`)
  }

  rmSync(join(OUT, 'chunks'), { recursive: true, force: true })
  mkdirSync(join(OUT, 'chunks'), { recursive: true })
  for (const file of code) writeFileSync(file.path, file.contents)
  writeFileSync(join(OUT, LEGAL), mergeLegal(kept.filter(file => file.path.endsWith('.LEGAL.txt')).map(file => file.text)))
  console.log(`${basename(OUT)}/: ${code.length} files, largest ${Math.max(...code.map(file => file.contents.byteLength))} bytes`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
