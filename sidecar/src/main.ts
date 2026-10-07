// Meanwhileサイドカー。Claude CodeのMod環境にはソケットがないため、
// WebRTC(werift)とマッチングサーバーとのWebSocketはこのプロセスが受け持つ。
//
// - Mod → サイドカー: Unixソケット上のHTTP(POST /、トークン必須)
// - サイドカー → Mod: 標準出力に「@mw <JSON>」を1行ずつ
//
// 通信先はマッチングサーバー(MEANWHILE_SERVER)と、マッチした相手(WebRTC)だけ。

import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'

import { isLang } from '../../shared/wire.ts'
import { createIdentity } from './identity.ts'
import { type Result, Session, type SidecarEvent } from './session.ts'

const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
const MAX_BODY = 4_096

function emit(event: SidecarEvent): void {
  process.stdout.write(`@mw ${JSON.stringify(event)}\n`)
}

function fatal(message: string): never {
  emit({ ev: 'error', message })
  process.exit(1)
}

const socketPath = process.env.MEANWHILE_SOCKET ?? fatal('MEANWHILE_SOCKET is not set')
const token = process.env.MEANWHILE_TOKEN ?? fatal('MEANWHILE_TOKEN is not set')
const server = (process.env.MEANWHILE_SERVER ?? '').replace(/\/+$/, '')
if (!/^wss?:\/\/[^/\s]+$/.test(server)) fatal('MEANWHILE_SERVER must be ws://host or wss://host')
if (token.length < 32) fatal('MEANWHILE_TOKEN is too short')
const stun = (process.env.MEANWHILE_STUN ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(s => /^stuns?:[^\s]+$/.test(s))

const session = new Session({
  server,
  stun: stun.length > 0 ? stun : DEFAULT_STUN,
  identity: createIdentity(),
  emit,
})

type Command =
  | { cmd: 'join'; lang: string }
  | { cmd: 'leave' }
  | { cmd: 'send'; text: string }
  | { cmd: 'final'; text: string | null }
  | { cmd: 'block' }
  | { cmd: 'report' }
  | { cmd: 'status' }
  | { cmd: 'quit' }

function parseCommand(raw: string): Command | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const m = value as Record<string, unknown>
  switch (m.cmd) {
    case 'join':
      return isLang(m.lang) ? { cmd: 'join', lang: m.lang } : null
    case 'send':
      return typeof m.text === 'string' ? { cmd: 'send', text: m.text } : null
    case 'final':
      return typeof m.text === 'string' || m.text === null ? { cmd: 'final', text: m.text } : null
    case 'leave':
    case 'block':
    case 'report':
    case 'status':
    case 'quit':
      return { cmd: m.cmd }
    default:
      return null
  }
}

async function run(command: Command): Promise<Result & { phase?: string }> {
  switch (command.cmd) {
    case 'join':
      return session.join(command.lang)
    case 'leave':
      return session.leave()
    case 'send':
      return session.send(command.text)
    case 'final':
      return session.final(command.text)
    case 'block':
      return session.block()
    case 'report':
      return session.report('abuse')
    case 'status':
      return { ok: true, phase: session.phase }
    case 'quit':
      setTimeout(shutdown, 50)
      return { ok: true }
  }
}

const control = createServer((request, response) => {
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (request.method !== 'POST' || request.headers['x-meanwhile-token'] !== token) {
    reply(403, { ok: false, error: 'forbidden' })
    return
  }
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk: string) => {
    raw += chunk
    if (raw.length > MAX_BODY) request.destroy()
  })
  request.on('end', () => {
    const command = parseCommand(raw)
    if (!command) {
      reply(400, { ok: false, error: 'bad-command' })
      return
    }
    run(command).then(
      result => reply(200, result),
      () => reply(500, { ok: false, error: 'internal' }),
    )
  })
})

function shutdown(): void {
  session.shutdown()
  control.close()
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {
    // 消せなくても次回の起動で消す
  }
  process.exit(0)
}

if (existsSync(socketPath)) unlinkSync(socketPath)
control.listen(socketPath, () => {
  chmodSync(socketPath, 0o600)
  emit({ ev: 'ready' })
})

// Claude Codeが落ちたら(親が変わったら)一緒に終わる
const parent = process.ppid
setInterval(() => {
  if (process.ppid !== parent) shutdown()
}, 2_000).unref()
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)
