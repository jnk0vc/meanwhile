// 端から端までの確認: wrangler devでマッチングサーバーを立て、
// ビルド済みのサイドカーを3つ起動して、マッチ・会話・通報・ブロック・最後の一言を通す。
//
//   node scripts/e2e.mjs
//
// サーバーは本物のDurable Object(ローカルのworkerd)、WebRTCも本物のweriftで動く。
// サイドカーは本番と同じくLAN内のアドレスを相手に渡さないので、同じマシンの2つは
// ルーターのヘアピンNATで折り返してつながる。対応していないネットワークやオフラインでは、
// MEANWHILE_SHARE_LAN_ADDRESSES=1 node scripts/e2e.mjs で、LAN内のアドレスも渡して試す。

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const PORT = 8911
const SIDECAR = join(root, 'plugins/meanwhile/sidecar/meanwhile-sidecar.mjs')
const children = []

function fail(message) {
  console.error(`✖ ${message}`)
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
}

function ok(message) {
  console.log(`✔ ${message}`)
}

async function startServer() {
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--var', 'POW_BITS:6', '--inspector-port', '9331'], {
    cwd: join(root, 'server'),
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wrangler dev did not start in 60s')), 60_000)
    const onData = chunk => {
      if (String(chunk).includes('Ready on')) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => reject(new Error(`wrangler dev exited (${code})`)))
  })
}

function startSidecar(name) {
  const socket = join(tmpdir(), `mw-e2e-${name}-${process.pid}.sock`)
  const token = randomBytes(24).toString('hex')
  const child = spawn(process.execPath, [SIDECAR], {
    env: { ...process.env, MEANWHILE_SOCKET: socket, MEANWHILE_TOKEN: token, MEANWHILE_SERVER: `ws://127.0.0.1:${PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  const events = []
  const waiters = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('@mw ')) continue
      const event = JSON.parse(line.slice(4))
      events.push(event)
      for (const w of [...waiters]) if (w.match(event)) w.resolve(event)
    }
  })
  child.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`))

  const call = (body, headerToken = token) =>
    new Promise((resolve, reject) => {
      const req = request(
        { socketPath: socket, method: 'POST', path: '/', headers: { 'x-meanwhile-token': headerToken } },
        res => {
          let raw = ''
          res.setEncoding('utf8')
          res.on('data', c => (raw += c))
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }))
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })

  const waitFor = (predicate, label, ms = 15_000) => {
    const seen = events.find(predicate)
    if (seen) {
      events.splice(events.indexOf(seen), 1)
      return Promise.resolve(seen)
    }
    return new Promise((resolve, reject) => {
      const w = {
        match: predicate,
        resolve: event => {
          clearTimeout(timer)
          waiters.splice(waiters.indexOf(w), 1)
          events.splice(events.indexOf(event), 1)
          resolve(event)
        },
      }
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1)
        reject(new Error(`${name}: timed out waiting for ${label}; saw ${JSON.stringify(events)}`))
      }, ms)
      waiters.push(w)
    })
  }

  const ev = (kind, label = kind) => waitFor(e => e.ev === kind, label)
  return { name, call, waitFor, ev, events }
}

async function main() {
  await startServer()
  ok('wrangler devでマッチングサーバーが起動')

  const a = startSidecar('a')
  const b = startSidecar('b')
  await Promise.all([a.ev('ready'), b.ev('ready')])
  ok('サイドカー2つが制御ソケットを開いた')

  const forbidden = await a.call({ cmd: 'status' }, 'wrong-token')
  if (forbidden.status !== 403) fail(`トークン違いが通ってしまう: ${forbidden.status}`)
  ok('トークンが違う制御要求は403で断る')

  const t0 = Date.now()
  await a.call({ cmd: 'join', lang: 'ja' })
  await a.ev('queued')
  await b.call({ cmd: 'join', lang: 'en' })
  const [ca, cb] = await Promise.all([a.ev('connected'), b.ev('connected')])
  if (ca.lang !== 'en' || cb.lang !== 'ja') fail(`helloの言語が食い違う: ${ca.lang} / ${cb.lang}`)
  ok(`マッチしてDataChannelがつながった(${Date.now() - t0}ms、相手の言語a←${ca.lang} b←${cb.lang})`)

  await a.call({ cmd: 'send', text: 'こんにちは、何作ってるの？' })
  const got = await b.waitFor(e => e.ev === 'chat', 'chat from a')
  if (got.text !== 'こんにちは、何作ってるの？') fail(`本文が違う: ${got.text}`)
  await b.call({ cmd: 'send', text: 'Building a mod 🙂' })
  const back = await a.waitFor(e => e.ev === 'chat', 'chat from b')
  if (back.text !== 'Building a mod 🙂') fail(`本文が違う: ${back.text}`)
  ok('署名つきのチャットが双方向に届いた')

  const tooLong = await a.call({ cmd: 'send', text: 'x'.repeat(201) })
  if (tooLong.body.ok !== false) fail('201文字が送れてしまう')
  ok('201文字以上は送信前に断る')

  const report = await a.call({ cmd: 'report' })
  if (report.body.status !== 'accepted') fail(`通報が受理されない: ${JSON.stringify(report.body)}`)
  const left = await b.waitFor(e => e.ev === 'peer-left', 'peer-left after block')
  if (left.reason !== 'blocked') fail(`退室理由が違う: ${left.reason}`)
  ok('通報はサーバーで署名検証されて受理され、相手は即切断された')

  // ここまでに読み残した出来事(1回目のmatchedなど)は捨てて数え直す
  a.events.length = 0
  b.events.length = 0
  await a.call({ cmd: 'join', lang: 'ja' })
  await a.ev('queued')
  await b.call({ cmd: 'join', lang: 'en' })
  await b.ev('queued')
  await new Promise(resolve => setTimeout(resolve, 2_000))
  if ([...a.events, ...b.events].some(e => e.ev === 'matched')) fail('ブロックした相手と再マッチした')
  ok('ブロックした相手・直前の相手とは再マッチしない')

  const c = startSidecar('c')
  await c.ev('ready')
  await c.call({ cmd: 'join', lang: 'ko' })
  await Promise.all([a.ev('connected'), c.ev('connected')])
  ok('新しい相手(c)とは、先に並んでいたaが組まれた')

  await a.call({ cmd: 'final', text: 'またね！' })
  const final = await c.waitFor(e => e.ev === 'final', 'final from a')
  if (final.text !== 'またね！') fail(`最後の一言が違う: ${final.text}`)
  const cLeft = await c.waitFor(e => e.ev === 'peer-left', 'peer-left after final')
  if (cLeft.reason !== 'done') fail(`退室理由が違う: ${cLeft.reason}`)
  ok('最後の一言が届き、相手は「作業に戻った」扱いで退室した')

  for (const s of [a, b, c]) await s.call({ cmd: 'quit' }).catch(() => undefined)
  for (const child of children) child.kill('SIGTERM')
  console.log('\nすべて通りました')
  process.exit(0)
}

main().catch(error => fail(error.message))
