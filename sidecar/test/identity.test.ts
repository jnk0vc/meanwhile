import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkPow, linePayload, randomId, verifyEd25519 } from '../../shared/wire.ts'
import { createIdentity, solvePow } from '../src/identity.ts'

test('サイドカーの署名はサーバー側(Web Crypto)の検証で通る', async () => {
  const me = createIdentity()
  const roomId = randomId()
  const line = { type: 'chat' as const, seq: 1, ts: 2, text: 'やあ' }
  assert.equal(await verifyEd25519(me.publicKey, me.sign(linePayload(roomId, line)), linePayload(roomId, line)), true)
})

test('起動のたびに別の鍵になる', () => {
  assert.notEqual(createIdentity().publicKey, createIdentity().publicKey)
})

test('サイドカーが解いたproof-of-workはサーバー側の判定で通る', async () => {
  const me = createIdentity()
  const nonce = randomId()
  const pow = solvePow(nonce, me.publicKey, 12)
  assert.equal(await checkPow(nonce, me.publicKey, pow, 12), true)
  assert.throws(() => solvePow(nonce, me.publicKey, 30, 10), /proof-of-work/)
})
