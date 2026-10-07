// マッチングと荒らし対策の規則。Durable Objectから切り離して単体テストする。

export type Waiting = {
  pubkey: string
  ipHash: string
  avoid: readonly string[]
  joinedAt: number
}

/**
 * 待機列から相手を1人選ぶ。言語を混ぜたFIFOの1本で、
 * 自分自身(同じ鍵)と、どちらかが避けたい相手(直前の相手・ブロックした相手)は飛ばす。
 */
export function pickPartner<T extends Waiting>(me: Waiting, queue: readonly T[]): T | undefined {
  return [...queue]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .find(
      other =>
        other.pubkey !== me.pubkey &&
        !me.avoid.includes(other.pubkey) &&
        !other.avoid.includes(me.pubkey),
    )
}

/** 期限つきの記録。期限を過ぎたものは読み出し時に無いものとして扱う */
export type Expiring = { exp: number }

export function isAlive(record: Expiring | undefined, now: number): boolean {
  return record !== undefined && record.exp > now
}

export type Strikes = Expiring & { reporters: string[] }

export const STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000
export const BAN_MS = 24 * 60 * 60 * 1000
export const STRIKES_TO_BAN = 3

/**
 * 検証できた通報を1件数える。同じ通報者(IPのハッシュ)からの重複は数えない。
 * 別々の通報者からSTRIKES_TO_BAN件たまったら締め出す。
 */
export function addStrike(
  current: Strikes | undefined,
  reporterIpHash: string,
  now: number,
): { strikes: Strikes; shouldBan: boolean } {
  const base = isAlive(current, now) ? current! : { reporters: [], exp: now + STRIKE_WINDOW_MS }
  const reporters = base.reporters.includes(reporterIpHash) ? base.reporters : [...base.reporters, reporterIpHash]
  const strikes = { reporters, exp: base.exp }
  return { strikes, shouldBan: reporters.length >= STRIKES_TO_BAN }
}

/** IPごとの固定窓レート制限。メモリ上だけで持つ(DOが休止すれば忘れてよい) */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /** 1回ぶん記録し、上限内ならtrueを返す */
  take(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) this.sweep(now)
    return true
  }

  private sweep(now: number): void {
    for (const [key, list] of this.hits) {
      if (list.every(t => now - t >= this.windowMs)) this.hits.delete(key)
    }
  }
}
