// Meanwhileのワイヤプロトコル。マッチングサーバー(Cloudflare Worker)と
// サイドカー(Node)の両方から読み込むため、Web標準のAPIだけで書く。
// 受け取ったものはすべて信用せず、ここのparse* を通してから使う。

export const PROTOCOL_VERSION = 1
export const MAX_TEXT = 200
export const MAX_SIGNAL_BYTES = 16_384
export const MAX_PEER_BYTES = 2_048
export const MAX_REPORT_BYTES = 32_768
export const MAX_EVIDENCE = 20
export const MAX_AVOID = 8
export const SIGN_DOMAIN = 'meanwhile/1'

export type NoticeCode =
  | 'banned'
  | 'rate-limited'
  | 'bad-request'
  | 'peer-left'
  | 'busy'

export type SdpInit = { type: 'offer' | 'answer'; sdp: string }
export type IceInit = {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

export type ClientMessage =
  | { type: 'queue.join'; pubkey: string; pow: string; avoid: string[] }
  | { type: 'queue.leave' }
  | { type: 'signal'; sdp?: SdpInit; ice?: IceInit | null }

export type ServerMessage =
  | { type: 'challenge'; nonce: string; bits: number }
  | { type: 'match.found'; roomId: string; role: 'offer' | 'answer'; peerKey: string }
  | { type: 'signal'; sdp?: SdpInit; ice?: IceInit | null }
  | { type: 'notice'; code: NoticeCode }

export type SignedKind = 'chat' | 'final'
export type SignedLine = {
  type: SignedKind
  seq: number
  ts: number
  text: string | null
  sig: string
}

export type PeerMessage =
  | { type: 'hello'; v: number; lang: string }
  | SignedLine
  | { type: 'bye'; reason: 'done' | 'blocked' }
  | { type: 'ping' }

export type ReportReason = 'abuse' | 'scam' | 'spam' | 'other'
export type ReportBody = {
  roomId: string
  reporterKey: string
  reason: ReportReason
  evidence: SignedLine[]
  sig: string
}

// ---- base64url ----

const B64U = /^[A-Za-z0-9_-]*$/

export function toB64u(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function fromB64u(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64U.test(text) || text.length % 4 === 1) return null
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)
  try {
    const bin = atob(padded)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** Ed25519の公開鍵(32バイト)をbase64urlにしたもの */
export function isPublicKey(value: unknown): value is string {
  return typeof value === 'string' && value.length === 43 && fromB64u(value)?.length === 32
}

/** Ed25519の署名(64バイト)をbase64urlにしたもの */
export function isSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length === 86 && fromB64u(value)?.length === 64
}

export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 22 && fromB64u(value)?.length === 16
}

export function isLang(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)
}

export function randomId(bytes = 16): string {
  return toB64u(crypto.getRandomValues(new Uint8Array(bytes)))
}

// ---- 検証の小道具 ----

type Obj = Record<string, unknown>

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(raw: string, limit: number): Obj | null {
  if (raw.length > limit) return null
  try {
    const value: unknown = JSON.parse(raw)
    return isObj(value) ? value : null
  } catch {
    return null
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && [...value].length <= MAX_TEXT
}

function isSeq(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function optString(value: unknown, max: number): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= max)
}

function parseSdp(value: unknown): SdpInit | null {
  if (!isObj(value)) return null
  if (value.type !== 'offer' && value.type !== 'answer') return null
  if (typeof value.sdp !== 'string' || value.sdp.length === 0 || value.sdp.length > 12_000) return null
  return { type: value.type, sdp: value.sdp }
}

function parseIce(value: unknown): IceInit | null | undefined {
  if (value === null) return null
  if (!isObj(value)) return undefined
  if (typeof value.candidate !== 'string' || value.candidate.length > 1024) return undefined
  if (!optString(value.sdpMid, 32) || !optString(value.usernameFragment, 256)) return undefined
  const index = value.sdpMLineIndex
  if (index !== undefined && index !== null && !(Number.isInteger(index) && (index as number) >= 0 && (index as number) < 16)) {
    return undefined
  }
  return {
    candidate: value.candidate,
    sdpMid: (value.sdpMid as string | null | undefined) ?? null,
    sdpMLineIndex: (index as number | null | undefined) ?? null,
    usernameFragment: (value.usernameFragment as string | null | undefined) ?? null,
  }
}

function parseSignal(m: Obj): { type: 'signal'; sdp?: SdpInit; ice?: IceInit | null } | null {
  const hasSdp = m.sdp !== undefined
  const hasIce = m.ice !== undefined
  if (hasSdp === hasIce) return null
  if (hasSdp) {
    const sdp = parseSdp(m.sdp)
    return sdp ? { type: 'signal', sdp } : null
  }
  const ice = parseIce(m.ice)
  return ice === undefined ? null : { type: 'signal', ice }
}

// ---- シグナリング(WebSocket) ----

export function parseClientMessage(raw: string): ClientMessage | null {
  const m = parseJson(raw, MAX_SIGNAL_BYTES)
  if (!m) return null
  switch (m.type) {
    case 'queue.join': {
      if (!isPublicKey(m.pubkey)) return null
      if (typeof m.pow !== 'string' || !/^[0-9a-z]{1,32}$/.test(m.pow)) return null
      const avoid = m.avoid ?? []
      if (!Array.isArray(avoid) || avoid.length > MAX_AVOID || !avoid.every(isPublicKey)) return null
      return { type: 'queue.join', pubkey: m.pubkey, pow: m.pow, avoid }
    }
    case 'queue.leave':
      return { type: 'queue.leave' }
    case 'signal':
      return parseSignal(m)
    default:
      return null
  }
}

const NOTICES: readonly NoticeCode[] = ['banned', 'rate-limited', 'bad-request', 'peer-left', 'busy']

export function parseServerMessage(raw: string): ServerMessage | null {
  const m = parseJson(raw, MAX_SIGNAL_BYTES)
  if (!m) return null
  switch (m.type) {
    case 'challenge':
      if (typeof m.nonce !== 'string' || fromB64u(m.nonce)?.length !== 16) return null
      if (!Number.isInteger(m.bits) || (m.bits as number) < 0 || (m.bits as number) > 28) return null
      return { type: 'challenge', nonce: m.nonce, bits: m.bits as number }
    case 'match.found':
      if (!isRoomId(m.roomId) || !isPublicKey(m.peerKey)) return null
      if (m.role !== 'offer' && m.role !== 'answer') return null
      return { type: 'match.found', roomId: m.roomId, role: m.role, peerKey: m.peerKey }
    case 'signal':
      return parseSignal(m)
    case 'notice':
      return NOTICES.includes(m.code as NoticeCode) ? { type: 'notice', code: m.code as NoticeCode } : null
    default:
      return null
  }
}

// ---- 相手との会話(DataChannel) ----

export function parseSignedLine(m: Obj): SignedLine | null {
  if (m.type !== 'chat' && m.type !== 'final') return null
  if (!isSeq(m.seq) || !isSeq(m.ts) || !isSignature(m.sig)) return null
  if (m.type === 'chat' && !isText(m.text)) return null
  if (m.type === 'final' && m.text !== null && !isText(m.text)) return null
  return { type: m.type, seq: m.seq, ts: m.ts, text: m.text as string | null, sig: m.sig }
}

export function parsePeerMessage(raw: string): PeerMessage | null {
  const m = parseJson(raw, MAX_PEER_BYTES)
  if (!m) return null
  switch (m.type) {
    case 'hello':
      if (!Number.isInteger(m.v) || !isLang(m.lang)) return null
      return { type: 'hello', v: m.v as number, lang: m.lang }
    case 'chat':
    case 'final':
      return parseSignedLine(m)
    case 'bye':
      return m.reason === 'done' || m.reason === 'blocked' ? { type: 'bye', reason: m.reason } : null
    case 'ping':
      return { type: 'ping' }
    default:
      return null
  }
}

// ---- 署名 ----

const encoder = new TextEncoder()

/** Web Cryptoに渡せる形(ArrayBufferを持つUint8Array)でUTF-8にする */
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(text))
}

/** 会話1通ぶんの署名対象。部屋をまたいだ使い回しを防ぐためroomIdを含める */
export function linePayload(roomId: string, line: Omit<SignedLine, 'sig'>): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify([SIGN_DOMAIN, 'line', roomId, line.type, line.seq, line.ts, line.text]))
}

/** 通報そのものの署名対象。通報者が部屋の当事者であることを示す */
export function reportPayload(roomId: string, reason: ReportReason, evidence: readonly SignedLine[]): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify([SIGN_DOMAIN, 'report', roomId, reason, evidence.map(e => e.sig)]))
}

export async function verifyEd25519(publicKey: string, signature: string, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const raw = fromB64u(publicKey)
  const sig = fromB64u(signature)
  if (raw?.length !== 32 || sig?.length !== 64) return false
  try {
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, data)
  } catch {
    return false
  }
}

const REASONS: readonly ReportReason[] = ['abuse', 'scam', 'spam', 'other']

export function parseReportBody(raw: string): ReportBody | null {
  const m = parseJson(raw, MAX_REPORT_BYTES)
  if (!m) return null
  if (!isRoomId(m.roomId) || !isPublicKey(m.reporterKey) || !isSignature(m.sig)) return null
  if (!REASONS.includes(m.reason as ReportReason)) return null
  if (!Array.isArray(m.evidence) || m.evidence.length > MAX_EVIDENCE) return null
  const evidence: SignedLine[] = []
  for (const item of m.evidence) {
    const line = isObj(item) ? parseSignedLine(item) : null
    if (!line) return null
    evidence.push(line)
  }
  return { roomId: m.roomId, reporterKey: m.reporterKey, reason: m.reason as ReportReason, evidence, sig: m.sig }
}

// ---- proof-of-work ----

export function powInput(nonce: string, pubkey: string, pow: string): Uint8Array<ArrayBuffer> {
  return utf8(`${nonce}.${pubkey}.${pow}`)
}

export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8
      continue
    }
    return bits + Math.clz32(byte) - 24
  }
  return bits
}

export async function checkPow(nonce: string, pubkey: string, pow: string, bits: number): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', powInput(nonce, pubkey, pow)))
  return leadingZeroBits(digest) >= bits
}
