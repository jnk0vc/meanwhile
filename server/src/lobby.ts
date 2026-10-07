import { DurableObject } from 'cloudflare:workers'

import {
  MAX_REPORT_BYTES,
  MAX_SIGNAL_BYTES,
  type NoticeCode,
  type ServerMessage,
  checkPow,
  linePayload,
  parseClientMessage,
  parseReportBody,
  randomId,
  reportPayload,
  toB64u,
  verifyEd25519,
} from '../../shared/wire.ts'
import {
  BAN_MS,
  type Expiring,
  RateLimiter,
  type Strikes,
  addStrike,
  isAlive,
  pickPartner,
} from './rules.ts'

export type Env = {
  LOBBY: DurableObjectNamespace<Lobby>
  /** queue.joinに求めるproof-of-workの難しさ(先頭のゼロビット数) */
  POW_BITS?: string
  /** IPをハッシュにするときの塩。未設定ならDOが初回に作って保存する */
  IP_SALT?: string
}

type Attachment = {
  ipHash: string
  nonce: string
  state: 'challenged' | 'queued' | 'matched'
  pubkey?: string
  avoid?: string[]
  joinedAt?: number
  roomId?: string
  signals?: number
}

/** 通報の検証に使う部屋の記録。本文は持たず、鍵とIPのハッシュだけを1時間残す */
type Room = Expiring & {
  keys: [string, string]
  ipHashes: [string, string]
  reportedBy: number[]
}

const ROOM_TTL_MS = 60 * 60 * 1000
const MAX_SIGNALS_PER_SOCKET = 200
const MAX_QUEUED_PER_IP = 3

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export class Lobby extends DurableObject<Env> {
  private connects = new RateLimiter(30, 10 * 60 * 1000)
  private reports = new RateLimiter(10, 60 * 60 * 1000)
  private salt: string | undefined

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') return this.accept(request)
    if (url.pathname === '/report' && request.method === 'POST') return this.report(request)
    return new Response('not found', { status: 404 })
  }

  // ---- WebSocket ----

  private async accept(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const ipHash = await this.hashIp(request)
    const now = Date.now()
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)

    // 締め出し中・レート制限中でも一度受け入れて理由を伝えてから閉じる
    if (isAlive(await this.ctx.storage.get<Expiring>(`ban:ip:${ipHash}`), now)) {
      this.refuse(server, 'banned')
    } else if (!this.connects.take(ipHash, now)) {
      this.refuse(server, 'rate-limited')
    } else {
      const attachment: Attachment = { ipHash, nonce: randomId(), state: 'challenged' }
      server.serializeAttachment(attachment)
      this.send(server, { type: 'challenge', nonce: attachment.nonce, bits: this.powBits() })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_SIGNAL_BYTES) return this.refuse(ws, 'bad-request')
    const msg = parseClientMessage(message)
    const att = ws.deserializeAttachment() as Attachment | null
    if (!msg || !att) return this.refuse(ws, 'bad-request')

    switch (msg.type) {
      case 'queue.join': {
        if (att.state !== 'challenged') return this.refuse(ws, 'bad-request')
        if (!(await checkPow(att.nonce, msg.pubkey, msg.pow, this.powBits()))) return this.refuse(ws, 'bad-request')
        if (isAlive(await this.ctx.storage.get<Expiring>(`ban:key:${msg.pubkey}`), Date.now())) {
          return this.refuse(ws, 'banned')
        }
        const queuedFromIp = this.sockets().filter(([, a]) => a.state === 'queued' && a.ipHash === att.ipHash)
        if (queuedFromIp.length >= MAX_QUEUED_PER_IP) return this.refuse(ws, 'rate-limited')

        const queued: Attachment = { ...att, state: 'queued', pubkey: msg.pubkey, avoid: msg.avoid, joinedAt: Date.now() }
        ws.serializeAttachment(queued)
        await this.tryMatch(ws, queued)
        return
      }
      case 'queue.leave': {
        if (att.state === 'matched') {
          const peer = this.peerOf(ws, att)
          if (peer) this.send(peer, { type: 'notice', code: 'peer-left' })
        }
        ws.close(1000, 'leave')
        return
      }
      case 'signal': {
        if (att.state !== 'matched') return
        const signals = (att.signals ?? 0) + 1
        if (signals > MAX_SIGNALS_PER_SOCKET) return this.refuse(ws, 'rate-limited')
        ws.serializeAttachment({ ...att, signals })
        const peer = this.peerOf(ws, att)
        if (peer) this.send(peer, msg)
        return
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      // 既に閉じている
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error')
    } catch {
      // 既に閉じている
    }
  }

  private async tryMatch(ws: WebSocket, me: Attachment): Promise<void> {
    const queue = this.sockets()
      .filter(([other, a]) => other !== ws && a.state === 'queued' && a.pubkey && a.joinedAt)
      .map(([socket, a]) => ({ socket, a, pubkey: a.pubkey!, ipHash: a.ipHash, avoid: a.avoid ?? [], joinedAt: a.joinedAt! }))
    const partner = pickPartner(
      { pubkey: me.pubkey!, ipHash: me.ipHash, avoid: me.avoid ?? [], joinedAt: me.joinedAt! },
      queue,
    )
    if (!partner) return

    const roomId = randomId()
    // 先に並んでいた側がofferを作る
    partner.socket.serializeAttachment({ ...partner.a, state: 'matched', roomId, signals: 0 })
    ws.serializeAttachment({ ...me, state: 'matched', roomId, signals: 0 })

    const room: Room = {
      keys: [partner.pubkey, me.pubkey!],
      ipHashes: [partner.ipHash, me.ipHash],
      reportedBy: [],
      exp: Date.now() + ROOM_TTL_MS,
    }
    await this.ctx.storage.put(`room:${roomId}`, room)
    await this.ensureAlarm()

    this.send(partner.socket, { type: 'match.found', roomId, role: 'offer', peerKey: me.pubkey! })
    this.send(ws, { type: 'match.found', roomId, role: 'answer', peerKey: partner.pubkey })
  }

  private sockets(): [WebSocket, Attachment][] {
    return this.ctx
      .getWebSockets()
      .filter(ws => ws.readyState === WebSocket.OPEN)
      .map(ws => [ws, ws.deserializeAttachment() as Attachment | null] as const)
      .filter((pair): pair is [WebSocket, Attachment] => pair[1] !== null)
  }

  private peerOf(ws: WebSocket, att: Attachment): WebSocket | undefined {
    return this.sockets().find(([other, a]) => other !== ws && a.state === 'matched' && a.roomId === att.roomId)?.[0]
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // 相手側が閉じかけている
    }
  }

  private refuse(ws: WebSocket, code: NoticeCode): void {
    this.send(ws, { type: 'notice', code })
    try {
      ws.close(1008, code)
    } catch {
      // 既に閉じている
    }
  }

  // ---- 通報 ----

  /**
   * 通報を受けて署名を検証する。本文(証拠)は検証に使ったら捨て、保存しない。
   * 残すのは「どのIPのハッシュが何人から通報されたか」だけ。
   */
  private async report(request: Request): Promise<Response> {
    const reporterIp = await this.hashIp(request)
    const now = Date.now()
    if (!this.reports.take(reporterIp, now)) return json({ status: 'rate-limited' }, 429)

    const raw = await request.text()
    if (raw.length > MAX_REPORT_BYTES) return json({ status: 'bad-request' }, 400)
    const body = parseReportBody(raw)
    if (!body) return json({ status: 'bad-request' }, 400)

    const room = await this.ctx.storage.get<Room>(`room:${body.roomId}`)
    if (!room || !isAlive(room, now)) return json({ status: 'unknown-room' }, 404)
    const index = room.keys.indexOf(body.reporterKey)
    if (index === -1) return json({ status: 'forbidden' }, 403)
    if (!(await verifyEd25519(body.reporterKey, body.sig, reportPayload(body.roomId, body.reason, body.evidence)))) {
      return json({ status: 'forbidden' }, 403)
    }
    if (room.reportedBy.includes(index)) return json({ status: 'duplicate' }, 409)
    await this.ctx.storage.put(`room:${body.roomId}`, { ...room, reportedBy: [...room.reportedBy, index] })

    const other = index === 0 ? 1 : 0
    const reportedKey = room.keys[other]
    const reportedIp = room.ipHashes[other]
    let verified = 0
    for (const line of body.evidence) {
      const { sig, ...unsigned } = line
      if (await verifyEd25519(reportedKey, sig, linePayload(body.roomId, unsigned))) verified += 1
    }
    // 相手が実際に送った(署名が通った)発言がなければ、通報は数えない
    if (verified === 0) return json({ status: 'unverified' }, 202)

    const { strikes, shouldBan } = addStrike(
      await this.ctx.storage.get<Strikes>(`strike:${reportedIp}`),
      room.ipHashes[index],
      now,
    )
    await this.ctx.storage.put(`strike:${reportedIp}`, strikes)
    if (shouldBan) {
      const ban: Expiring = { exp: now + BAN_MS }
      await this.ctx.storage.put({ [`ban:ip:${reportedIp}`]: ban, [`ban:key:${reportedKey}`]: ban })
      for (const [ws, a] of this.sockets()) {
        if (a.ipHash === reportedIp && a.state !== 'matched') this.refuse(ws, 'banned')
      }
    }
    await this.ensureAlarm()
    return json({ status: 'accepted' })
  }

  // ---- 後片づけ ----

  override async alarm(): Promise<void> {
    const now = Date.now()
    let remaining = 0
    for (const prefix of ['room:', 'strike:', 'ban:']) {
      const records = await this.ctx.storage.list<Expiring>({ prefix })
      const expired = [...records].filter(([, r]) => !isAlive(r, now)).map(([key]) => key)
      remaining += records.size - expired.length
      for (let i = 0; i < expired.length; i += 128) await this.ctx.storage.delete(expired.slice(i, i + 128))
    }
    if (remaining > 0) await this.ctx.storage.setAlarm(now + 10 * 60 * 1000)
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000)
    }
  }

  // ---- 小道具 ----

  private powBits(): number {
    const bits = Number(this.env.POW_BITS ?? '18')
    return Number.isInteger(bits) && bits >= 0 && bits <= 28 ? bits : 18
  }

  /** IPは生のまま保存しない。塩つきハッシュの先頭16バイトだけを使う */
  private async hashIp(request: Request): Promise<string> {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    if (this.salt === undefined) {
      this.salt = this.env.IP_SALT ?? (await this.ctx.storage.get<string>('salt'))
      if (this.salt === undefined) {
        this.salt = randomId(32)
        await this.ctx.storage.put('salt', this.salt)
      }
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}|${ip}`))
    return toB64u(new Uint8Array(digest).slice(0, 16))
  }
}
