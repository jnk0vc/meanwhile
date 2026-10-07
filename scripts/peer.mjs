// 試運転用の相手役。ビルド済みのサイドカーを1つ起動して待機列に並び、
// 届いたメッセージを表示する。相手が去ったら並び直す。
//
//   node scripts/peer.mjs [--lang en] [--server ws://127.0.0.1:8787]
//
// 標準入力の1行がそのままチャットになる。/final <文>・/skip・/leave・/block で退室する。
// 起動時に表示する curl の形で、別のシェルから送ることもできる。

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const lang = option('lang', 'en')
const server = option('server', 'ws://127.0.0.1:8787')

const sidecar = fileURLToPath(new URL('../plugins/meanwhile/sidecar/meanwhile-sidecar.mjs', import.meta.url))
const socketPath = join(tmpdir(), `mw-peer-${process.pid}.sock`)
const token = randomBytes(24).toString('hex')
const stamp = () => new Date().toTimeString().slice(0, 8)
const say = line => console.log(`${stamp()} ${line}`)

const child = spawn(process.execPath, [sidecar], {
  env: { ...process.env, MEANWHILE_SOCKET: socketPath, MEANWHILE_TOKEN: token, MEANWHILE_SERVER: server },
  stdio: ['ignore', 'pipe', 'inherit'],
})

function call(body) {
  return new Promise(resolve => {
    const req = request({ socketPath, method: 'POST', path: '/', headers: { 'x-meanwhile-token': token } }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (raw += chunk))
      res.on('end', () => resolve(raw))
    })
    req.on('error', error => resolve(JSON.stringify({ ok: false, error: error.message })))
    req.end(JSON.stringify(body))
  })
}

async function rejoin() {
  await call({ cmd: 'join', lang })
}

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
    switch (event.ev) {
      case 'ready':
        say(`制御ソケット: curl -s --unix-socket ${socketPath} -H 'x-meanwhile-token: ${token}' -d '{"cmd":"send","text":"hi"}' http://peer/`)
        void rejoin()
        break
      case 'queued':
        say(`待機列に並びました(lang=${lang})`)
        break
      case 'matched':
        say('マッチしました。つないでいます…')
        break
      case 'connected':
        say(`つながりました。相手の言語: ${event.lang}`)
        break
      case 'chat':
        say(`Someone: ${event.text}`)
        break
      case 'final':
        say(`Someone(最後の一言): ${event.text ?? '(スキップ)'}`)
        break
      case 'peer-left':
        say(`相手が退室しました(${event.reason})。並び直します`)
        setTimeout(rejoin, 500)
        break
      case 'connect-failed':
        say(`つながりませんでした(${event.reason})。並び直します`)
        setTimeout(rejoin, 500)
        break
      default:
        say(JSON.stringify(event))
    }
  }
})
child.on('exit', code => {
  say(`サイドカーが終了しました(${code})`)
  process.exit(code ?? 1)
})

createInterface({ input: process.stdin }).on('line', async line => {
  const text = line.trim()
  if (!text) return
  let reply
  if (text === '/leave') reply = await call({ cmd: 'leave' })
  else if (text === '/block') reply = await call({ cmd: 'block' })
  else if (text === '/skip') reply = await call({ cmd: 'final', text: null })
  else if (text.startsWith('/final ')) reply = await call({ cmd: 'final', text: text.slice(7) })
  else reply = await call({ cmd: 'send', text })
  if (!JSON.parse(reply).ok) say(`送れませんでした: ${reply}`)
  if (text === '/leave' || text === '/block' || text === '/skip' || text.startsWith('/final ')) setTimeout(rejoin, 500)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await call({ cmd: 'quit' })
    process.exit(0)
  })
}
