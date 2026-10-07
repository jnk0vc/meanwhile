// サイドカー(Nodeプロセス)とのやりとりの形。起動と呼び出しはregister.tsxが行う
// ($ を渡せるのは同じファイルのトップレベル関数だけのため)。
//
// - 起動: $.process.spawn。Modが読み込み直されるとサイドカーも終わる
// - 指示: Unixソケット上のHTTP($.http.fetchのsocketPath)。起動ごとのトークン必須
// - 知らせ: サイドカーの標準出力に1行ずつ「@mw <JSON>」

export type SidecarEvent =
  | { ev: 'ready' }
  | { ev: 'queued' }
  | { ev: 'matched' }
  | { ev: 'connected'; lang: string }
  | { ev: 'connect-failed'; reason: string }
  | { ev: 'chat'; text: string }
  | { ev: 'final'; text: string | null }
  | { ev: 'peer-left'; reason: 'done' | 'blocked' | 'lost' }
  | { ev: 'notice'; code: 'banned' | 'rate-limited' | 'bad-request' | 'peer-left' | 'busy' }
  | { ev: 'error'; message: string }
  | { ev: 'exited' }

export type Command =
  | { cmd: 'join'; lang: string }
  | { cmd: 'leave' }
  | { cmd: 'send'; text: string }
  | { cmd: 'final'; text: string | null }
  | { cmd: 'block' }
  | { cmd: 'report' }
  | { cmd: 'quit' }

export type Reply = { ok: boolean; error?: string; status?: string }

/** 起動済みのサイドカー。制御ソケットの場所とトークン */
export type Bridge = { socketPath: string; token: string }

export class SidecarError extends Error {
  readonly code: 'no-node' | 'no-sidecar'

  constructor(code: 'no-node' | 'no-sidecar') {
    super(code)
    this.code = code
  }
}

export const MIN_NODE_MAJOR = 22
const NOTICE_CODES = ['banned', 'rate-limited', 'bad-request', 'peer-left', 'busy'] as const
const LEFT_REASONS = ['done', 'blocked', 'lost'] as const
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/** サイドカーの1行を検証する。知らない形・壊れた行は捨てる */
export function parseSidecarLine(line: string): SidecarEvent | null {
  if (!line.startsWith('@mw ') || line.length > 4_096) return null
  let value: unknown
  try {
    value = JSON.parse(line.slice(4))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const e = value as Record<string, unknown>
  switch (e.ev) {
    case 'ready':
    case 'queued':
    case 'matched':
      return { ev: e.ev }
    case 'connected':
      return typeof e.lang === 'string' && LANG.test(e.lang) ? { ev: 'connected', lang: e.lang } : null
    case 'connect-failed':
      return { ev: 'connect-failed', reason: typeof e.reason === 'string' ? e.reason.slice(0, 40) : 'unknown' }
    case 'chat':
      return typeof e.text === 'string' && e.text.length <= 1_000 ? { ev: 'chat', text: e.text } : null
    case 'final':
      return e.text === null || (typeof e.text === 'string' && e.text.length <= 1_000) ? { ev: 'final', text: e.text } : null
    case 'peer-left':
      return LEFT_REASONS.includes(e.reason as never) ? { ev: 'peer-left', reason: e.reason as (typeof LEFT_REASONS)[number] } : null
    case 'notice':
      return NOTICE_CODES.includes(e.code as never) ? { ev: 'notice', code: e.code as (typeof NOTICE_CODES)[number] } : null
    case 'error':
      return { ev: 'error', message: typeof e.message === 'string' ? e.message.slice(0, 200) : 'unknown' }
    default:
      return null
  }
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** macOSのUnixソケットのパスは104バイトまで。長すぎれば /tmpに置く */
export function socketPathFor(tmpdir: string | undefined, id: string): string {
  const dir = (tmpdir ?? '/tmp/').replace(/\/?$/, '/')
  const path = `${dir}meanwhile-${id}.sock`
  return path.length < 100 ? path : `/tmp/meanwhile-${id}.sock`
}

/** `node --version` の出力が対応版か */
export function isSupportedNode(version: string): boolean {
  const major = Number(/^v(\d+)\./.exec(version.trim())?.[1])
  return Number.isInteger(major) && major >= MIN_NODE_MAJOR
}

/** 標準出力の断片を行に分ける。読み残しは次の断片とつなぐ */
export function splitLines(buffer: string, piece: string): { lines: string[]; rest: string } {
  const joined = buffer + piece
  const parts = joined.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest: rest.length > 65_536 ? '' : rest }
}
