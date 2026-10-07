import { type KeyObject, createPublicKey, verify } from 'node:crypto'

import { type RTCDataChannel, RTCPeerConnection } from 'werift'

import {
  MAX_TEXT,
  type NoticeCode,
  PROTOCOL_VERSION,
  type ClientMessage,
  type IceInit,
  type ReportReason,
  type SdpInit,
  type SignedLine,
  fromB64u,
  linePayload,
  parsePeerMessage,
  parseServerMessage,
  reportPayload,
} from '../../shared/wire.ts'
import { type Identity, solvePow } from './identity.ts'
import { scrubCandidate, scrubSdp } from './privacy.ts'

/** サイドカーからModへ知らせる出来事。標準出力に1行ずつ書く */
export type SidecarEvent =
  | { ev: 'ready' }
  | { ev: 'queued' }
  | { ev: 'matched' }
  | { ev: 'connected'; lang: string }
  | { ev: 'connect-failed'; reason: string }
  | { ev: 'chat'; text: string; ts: number }
  | { ev: 'final'; text: string | null }
  | { ev: 'peer-left'; reason: 'done' | 'blocked' | 'lost' }
  | { ev: 'notice'; code: NoticeCode }
  | { ev: 'error'; message: string }

export type Result = { ok: true; status?: string } | { ok: false; error: string }

export type SessionOptions = {
  /** マッチングサーバーの起点(ws:// かwss://)。/wsと /reportをつなげて使う */
  server: string
  stun: readonly string[]
  identity: Identity
  emit: (event: SidecarEvent) => void
  connectTimeoutMs?: number
  pingMs?: number
  deadMs?: number
  /** LAN内のアドレスも相手に渡す。同じマシン・同じLANでの試験用で、既定はfalse */
  shareLanAddresses?: boolean
}

type Phase = 'idle' | 'queued' | 'connecting' | 'open'

/** 通報に使うため、部屋を出たあとも直前の部屋だけ覚えておく */
type RoomMemory = { roomId: string; peerKey: string; evidence: SignedLine[] }

const MAX_EVIDENCE = 20
const INBOUND_LIMIT = 10
const INBOUND_WINDOW_MS = 10_000
const MAX_BLOCKED = 7

/**
 * 1回のマッチング〜会話〜退室を受け持つ。会話の中身は検証してからModに渡すだけで、
 * ここでは解釈しない(翻訳・表示・無害化はModの仕事)。
 */
export class Session {
  phase: Phase = 'idle'

  private readonly opts: Required<SessionOptions>
  private generation = 0
  private ws: WebSocket | undefined
  private pc: RTCPeerConnection | undefined
  private dc: RTCDataChannel | undefined
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private lang = 'en'
  private roomId: string | undefined
  private peerKey: string | undefined
  private peerKeyObject: KeyObject | undefined
  private peerLang: string | undefined
  private helloSent = false
  private noticed = false
  private seq = 0
  private lastPeerSeq = -1
  private lastHeard = 0
  private inbound: number[] = []
  private evidence: SignedLine[] = []
  private lastRoom: RoomMemory | undefined
  private previous: string | undefined
  private blocked: string[] = []

  constructor(options: SessionOptions) {
    this.opts = { connectTimeoutMs: 10_000, pingMs: 15_000, deadMs: 45_000, shareLanAddresses: false, ...options }
  }

  // ---- Modから呼ばれる操作 ----

  join(lang: string): Result {
    if (this.phase !== 'idle') return { ok: false, error: 'busy' }
    const gen = this.begin()
    this.lang = lang
    this.phase = 'queued'
    let ws: WebSocket
    try {
      ws = new WebSocket(`${this.opts.server}/ws`)
    } catch {
      this.phase = 'idle'
      return { ok: false, error: 'bad-server-url' }
    }
    this.ws = ws
    ws.onmessage = event => {
      if (gen === this.generation && typeof event.data === 'string') this.onServer(gen, event.data)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = undefined
      // マッチ前に切れたら待機をやめる。理由(notice)を受け取っていればそれで足りる
      if (this.phase === 'queued') {
        this.phase = 'idle'
        if (!this.noticed) this.opts.emit({ ev: 'error', message: 'server-closed' })
      }
    }
    return { ok: true }
  }

  leave(): Result {
    if (this.phase === 'connecting') this.sendServer({ type: 'queue.leave' })
    if (this.phase === 'open') this.sendPeer({ type: 'bye', reason: 'done' })
    this.end()
    return { ok: true }
  }

  send(text: string): Result {
    if (this.phase !== 'open') return { ok: false, error: 'not-open' }
    if (text.length === 0 || [...text].length > MAX_TEXT) return { ok: false, error: 'bad-text' }
    this.sendLine('chat', text)
    return { ok: true }
  }

  /** 最後の一言を送って退室する。textがnullならスキップ */
  async final(text: string | null): Promise<Result> {
    if (this.phase !== 'open') {
      this.end()
      return { ok: true, status: 'already-left' }
    }
    if (text !== null && (text.length === 0 || [...text].length > MAX_TEXT)) return { ok: false, error: 'bad-text' }
    this.sendLine('final', text)
    await this.flush()
    this.end()
    return { ok: true }
  }

  block(): Result {
    const key = this.peerKey ?? this.lastRoom?.peerKey
    if (this.phase === 'open') this.sendPeer({ type: 'bye', reason: 'blocked' })
    if (this.phase === 'connecting') this.sendServer({ type: 'queue.leave' })
    if (key) this.blocked = [key, ...this.blocked.filter(k => k !== key)].slice(0, MAX_BLOCKED)
    if (this.phase !== 'queued') this.end()
    return { ok: true }
  }

  /** 相手が送った署名つきの発言を添えて通報し、そのままブロックする */
  async report(reason: ReportReason): Promise<Result> {
    const room: RoomMemory | undefined =
      this.roomId && this.peerKey ? { roomId: this.roomId, peerKey: this.peerKey, evidence: this.evidence } : this.lastRoom
    if (!room) return { ok: false, error: 'no-room' }
    const evidence = room.evidence.slice(-MAX_EVIDENCE)
    const body = {
      roomId: room.roomId,
      reporterKey: this.opts.identity.publicKey,
      reason,
      evidence,
      sig: this.opts.identity.sign(reportPayload(room.roomId, reason, evidence)),
    }
    this.block()
    try {
      const response = await fetch(`${this.httpBase()}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      const answer = (await response.json().catch(() => ({}))) as { status?: unknown }
      return { ok: true, status: typeof answer.status === 'string' ? answer.status : String(response.status) }
    } catch {
      return { ok: false, error: 'report-failed' }
    }
  }

  shutdown(): void {
    if (this.phase === 'open') this.sendPeer({ type: 'bye', reason: 'done' })
    this.end()
  }

  // ---- マッチングサーバー ----

  private onServer(gen: number, raw: string): void {
    const msg = parseServerMessage(raw)
    if (!msg) return
    switch (msg.type) {
      case 'challenge': {
        if (this.phase !== 'queued') return
        const pubkey = this.opts.identity.publicKey
        const avoid = [...new Set([...(this.previous ? [this.previous] : []), ...this.blocked])].slice(0, 8)
        this.sendServer({ type: 'queue.join', pubkey, pow: solvePow(msg.nonce, pubkey, msg.bits), avoid })
        this.opts.emit({ ev: 'queued' })
        return
      }
      case 'match.found': {
        if (this.phase !== 'queued') return
        this.phase = 'connecting'
        this.roomId = msg.roomId
        this.peerKey = msg.peerKey
        this.peerKeyObject = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: msg.peerKey }, format: 'jwk' })
        this.opts.emit({ ev: 'matched' })
        this.later(gen, this.opts.connectTimeoutMs, () => {
          if (this.phase === 'connecting') this.fail('timeout')
        })
        void this.startPeer(gen, msg.role).catch(() => {
          if (gen === this.generation && this.phase === 'connecting') this.fail('webrtc-error')
        })
        return
      }
      case 'signal': {
        if (this.phase !== 'connecting' || !this.pc) return
        void this.onSignal(gen, msg.sdp, msg.ice).catch(() => {
          if (gen === this.generation && this.phase === 'connecting') this.fail('webrtc-error')
        })
        return
      }
      case 'notice': {
        this.opts.emit({ ev: 'notice', code: msg.code })
        if (msg.code === 'peer-left') {
          if (this.phase === 'connecting') this.fail('peer-left')
          return
        }
        this.noticed = true
        return
      }
    }
  }

  private sendServer(message: ClientMessage): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
    } catch {
      // 送れなければ、相手側のタイムアウトに任せる
    }
  }

  private httpBase(): string {
    return this.opts.server.replace(/^ws(s?):\/\//, 'http$1://')
  }

  // ---- WebRTC ----

  private async startPeer(gen: number, role: 'offer' | 'answer'): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: this.opts.stun.map(urls => ({ urls })) })
    this.pc = pc
    pc.onIceCandidate.subscribe(candidate => {
      if (gen !== this.generation) return
      if (!candidate) {
        this.sendServer({ type: 'signal', ice: null })
        return
      }
      const ice = candidate.toJSON() as IceInit
      const text = this.opts.shareLanAddresses ? ice.candidate : scrubCandidate(ice.candidate)
      if (text !== null) this.sendServer({ type: 'signal', ice: { ...ice, candidate: text } })
    })
    pc.connectionStateChange.subscribe(state => {
      if (gen !== this.generation) return
      if (state === 'failed' || state === 'closed') this.onChannelGone(gen)
    })
    if (role === 'offer') {
      this.attach(gen, pc.createDataChannel('meanwhile', { ordered: true }))
      await pc.setLocalDescription(await pc.createOffer())
      if (gen === this.generation && pc.localDescription) {
        this.sendServer({ type: 'signal', sdp: { type: 'offer', sdp: this.outgoingSdp(pc.localDescription.sdp) } })
      }
    } else {
      pc.onDataChannel.subscribe(dc => {
        if (gen === this.generation && !this.dc) this.attach(gen, dc)
      })
    }
  }

  private async onSignal(gen: number, sdp: SdpInit | undefined, ice: IceInit | null | undefined): Promise<void> {
    const pc = this.pc
    if (!pc) return
    if (sdp) {
      await pc.setRemoteDescription(sdp)
      if (sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer())
        if (gen === this.generation && pc.localDescription) {
          this.sendServer({ type: 'signal', sdp: { type: 'answer', sdp: this.outgoingSdp(pc.localDescription.sdp) } })
        }
      }
      return
    }
    if (ice !== undefined) await pc.addIceCandidate(ice)
  }

  private outgoingSdp(sdp: string): string {
    return this.opts.shareLanAddresses ? sdp : scrubSdp(sdp)
  }

  private attach(gen: number, dc: RTCDataChannel): void {
    this.dc = dc
    dc.stateChanged.subscribe(state => {
      if (gen !== this.generation) return
      if (state === 'open') this.sayHello()
      if (state === 'closed') this.onChannelGone(gen)
    })
    dc.onMessage.subscribe(data => {
      if (gen === this.generation && typeof data === 'string') this.onPeer(gen, data)
    })
    if (dc.readyState === 'open') this.sayHello()
  }

  private sayHello(): void {
    if (this.helloSent) return
    this.helloSent = true
    this.sendPeer({ type: 'hello', v: PROTOCOL_VERSION, lang: this.lang })
    if (this.peerLang) this.becomeOpen()
  }

  private becomeOpen(): void {
    if (this.phase !== 'connecting' || !this.peerLang) return
    const gen = this.generation
    this.phase = 'open'
    this.lastHeard = Date.now()
    // 会話が始まったらマッチングサーバーとの接続は閉じる
    const ws = this.ws
    this.ws = undefined
    ws?.close(1000, 'connected')
    this.opts.emit({ ev: 'connected', lang: this.peerLang })
    this.every(gen, this.opts.pingMs, () => this.sendPeer({ type: 'ping' }))
    this.every(gen, 1_000, () => {
      if (this.phase === 'open' && Date.now() - this.lastHeard > this.opts.deadMs) this.lost('lost')
    })
  }

  // ---- 相手からのメッセージ ----

  private onPeer(gen: number, raw: string): void {
    const msg = parsePeerMessage(raw)
    if (!msg) return
    this.lastHeard = Date.now()
    switch (msg.type) {
      case 'hello':
        if (this.peerLang) return
        this.peerLang = msg.lang
        if (this.helloSent) this.becomeOpen()
        return
      case 'ping':
        return
      case 'bye':
        if (this.phase === 'open' || this.phase === 'connecting') this.lost(msg.reason)
        return
      case 'chat':
      case 'final': {
        if (this.phase !== 'open' || !this.accept(msg)) return
        if (msg.type === 'chat') {
          this.opts.emit({ ev: 'chat', text: msg.text!, ts: msg.ts })
          return
        }
        this.opts.emit({ ev: 'final', text: msg.text })
        if (gen === this.generation) this.lost('done')
        return
      }
    }
  }

  /** 署名・順番・受信レートを確かめ、通ったものだけ証拠として残す */
  private accept(line: SignedLine): boolean {
    if (!this.roomId || !this.peerKeyObject || line.seq <= this.lastPeerSeq) return false
    const now = Date.now()
    this.inbound = this.inbound.filter(t => now - t < INBOUND_WINDOW_MS)
    if (this.inbound.length >= INBOUND_LIMIT) return false
    const sig = fromB64u(line.sig)
    const { sig: _sig, ...unsigned } = line
    if (!sig || !verify(null, linePayload(this.roomId, unsigned), this.peerKeyObject, sig)) return false
    this.inbound.push(now)
    this.lastPeerSeq = line.seq
    this.evidence = [...this.evidence, line].slice(-MAX_EVIDENCE)
    return true
  }

  private sendLine(type: 'chat' | 'final', text: string | null): void {
    if (!this.roomId) return
    this.seq += 1
    const unsigned = { type, seq: this.seq, ts: Date.now(), text }
    this.sendPeer({ ...unsigned, sig: this.opts.identity.sign(linePayload(this.roomId, unsigned)) })
  }

  private sendPeer(message: object): void {
    try {
      if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(message))
    } catch {
      // 切れかけている。生存確認のタイムアウトに任せる
    }
  }

  private async flush(): Promise<void> {
    for (let i = 0; i < 20 && (this.dc?.bufferedAmount ?? 0) > 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    // SCTPが送り切るまで少し待つ
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  // ---- 終わり方 ----

  private onChannelGone(gen: number): void {
    if (gen !== this.generation) return
    if (this.phase === 'open') this.lost('lost')
    else if (this.phase === 'connecting') this.fail('closed')
  }

  private lost(reason: 'done' | 'blocked' | 'lost'): void {
    this.end()
    this.opts.emit({ ev: 'peer-left', reason })
  }

  private fail(reason: string): void {
    // つながらなかった相手とは、同じセッションの中で組み直さない
    if (this.peerKey) this.previous = this.peerKey
    this.end()
    this.opts.emit({ ev: 'connect-failed', reason })
  }

  /** 新しい試行を始める。古い試行のコールバックはgenerationの不一致で無視される */
  private begin(): number {
    this.end()
    this.noticed = false
    return this.generation
  }

  private end(): void {
    this.generation += 1
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.roomId && this.peerKey) {
      this.lastRoom = { roomId: this.roomId, peerKey: this.peerKey, evidence: this.evidence }
      this.previous = this.peerKey
    }
    const { ws, dc, pc } = this
    this.ws = undefined
    this.dc = undefined
    this.pc = undefined
    try {
      ws?.close(1000, 'leave')
    } catch {
      // 閉じ済み
    }
    try {
      dc?.close()
    } catch {
      // 閉じ済み
    }
    void pc?.close().catch(() => undefined)
    this.phase = 'idle'
    this.roomId = undefined
    this.peerKey = undefined
    this.peerKeyObject = undefined
    this.peerLang = undefined
    this.helloSent = false
    this.seq = 0
    this.lastPeerSeq = -1
    this.inbound = []
    this.evidence = []
  }

  private later(gen: number, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (gen === this.generation) fn()
    }, ms)
    this.timers.add(timer)
  }

  private every(gen: number, ms: number, fn: () => void): void {
    const timer = setInterval(() => {
      if (gen === this.generation) fn()
    }, ms)
    this.timers.add(timer)
  }
}
