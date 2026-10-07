import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RateLimiter, STRIKES_TO_BAN, addStrike, isAlive, pickPartner } from '../src/rules.ts'

const waiting = (pubkey: string, joinedAt: number, avoid: string[] = []) => ({ pubkey, ipHash: `ip-${pubkey}`, avoid, joinedAt })

test('待機列はFIFOで、先に並んだ人から組む', () => {
  const me = waiting('me', 30)
  const picked = pickPartner(me, [waiting('c', 20), waiting('a', 5), waiting('b', 10)])
  assert.equal(picked?.pubkey, 'a')
})

test('自分自身と、どちらかが避けたい相手とは組まない', () => {
  const me = waiting('me', 30, ['a'])
  const queue = [waiting('me', 1), waiting('a', 2), waiting('b', 3, ['me']), waiting('c', 4)]
  assert.equal(pickPartner(me, queue)?.pubkey, 'c')
  assert.equal(pickPartner(me, queue.slice(0, 3)), undefined)
})

test('通報は別々の通報者から規定数たまったときだけ締め出しになる', () => {
  const now = 1_000
  let state = addStrike(undefined, 'reporter-1', now)
  assert.equal(state.shouldBan, STRIKES_TO_BAN <= 1)
  state = addStrike(state.strikes, 'reporter-1', now + 1)
  assert.equal(state.strikes.reporters.length, 1, '同じ通報者は1回だけ数える')
  state = addStrike(state.strikes, 'reporter-2', now + 2)
  assert.equal(state.shouldBan, false, '2人ではまだ締め出さない')
  state = addStrike(state.strikes, 'reporter-3', now + 3)
  assert.equal(state.shouldBan, true)
})

test('期限切れの通報記録は数え直しになる', () => {
  const first = addStrike(undefined, 'r1', 0).strikes
  const later = addStrike(first, 'r2', first.exp + 1)
  assert.deepEqual(later.strikes.reporters, ['r2'])
  assert.equal(isAlive(first, first.exp), false)
})

test('レート制限は窓の中で上限を超えた分だけ断る', () => {
  const limiter = new RateLimiter(2, 1_000)
  assert.equal(limiter.take('x', 0), true)
  assert.equal(limiter.take('x', 10), true)
  assert.equal(limiter.take('x', 20), false)
  assert.equal(limiter.take('y', 20), true)
  assert.equal(limiter.take('x', 1_005), true, '窓を過ぎた分は数えない')
})
