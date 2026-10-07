import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'

import {
  checkPow,
  fromB64u,
  leadingZeroBits,
  linePayload,
  parseClientMessage,
  parsePeerMessage,
  parseReportBody,
  parseServerMessage,
  randomId,
  reportPayload,
  toB64u,
  verifyEd25519,
} from '../../shared/wire.ts'

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'jwk' }).x!
  return { pub: raw, sign: (data: Uint8Array) => toB64u(sign(null, data, privateKey)) }
}

test('base64urlは往復でき、壊れた文字列はnullになる', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(33))
  assert.deepEqual(fromB64u(toB64u(bytes)), bytes)
  assert.equal(fromB64u('a+b/'), null)
  assert.equal(fromB64u('abcde'), null)
})

test('queue.joinは鍵とproof-of-workの形を検証する', () => {
  const { pub } = keyPair()
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'queue.join', pubkey: pub, pow: 'z9', avoid: [] })), {
    type: 'queue.join',
    pubkey: pub,
    pow: 'z9',
    avoid: [],
  })
  assert.equal(parseClientMessage(JSON.stringify({ type: 'queue.join', pubkey: 'short', pow: '1' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'queue.join', pubkey: pub, pow: 'A B' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'queue.join', pubkey: pub, pow: '1', avoid: Array(9).fill(pub) })), null)
})

test('signalはsdpかiceのどちらか一方だけを通す', () => {
  const sdp = { type: 'offer', sdp: 'v=0' }
  assert.ok(parseClientMessage(JSON.stringify({ type: 'signal', sdp })))
  assert.ok(parseClientMessage(JSON.stringify({ type: 'signal', ice: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0' } })))
  assert.ok(parseClientMessage(JSON.stringify({ type: 'signal', ice: null })), '候補の終わり')
  assert.equal(parseClientMessage(JSON.stringify({ type: 'signal', sdp, ice: null })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'signal' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'signal', sdp: { type: 'rollback', sdp: 'x' } })), null)
})

test('サーバーからの未知のtypeや壊れたJSONは捨てる', () => {
  assert.equal(parseServerMessage('{"type":"eval","code":"x"}'), null)
  assert.equal(parseServerMessage('not json'), null)
  assert.equal(parseServerMessage('{"type":"notice","code":"shutdown-now"}'), null)
  assert.deepEqual(parseServerMessage('{"type":"notice","code":"banned"}'), { type: 'notice', code: 'banned' })
})

test('相手からのメッセージはサイズ・文字数・未知のtypeを検証する', () => {
  const sig = toB64u(new Uint8Array(64))
  assert.ok(parsePeerMessage(JSON.stringify({ type: 'chat', seq: 1, ts: 2, text: 'やあ', sig })))
  assert.equal(parsePeerMessage(JSON.stringify({ type: 'chat', seq: 1, ts: 2, text: 'あ'.repeat(201), sig })), null)
  assert.ok(parsePeerMessage(JSON.stringify({ type: 'chat', seq: 1, ts: 2, text: '😀'.repeat(200), sig })), '絵文字は1文字と数える')
  assert.equal(parsePeerMessage(JSON.stringify({ type: 'chat', seq: 1, ts: 2, text: '', sig })), null)
  assert.ok(parsePeerMessage(JSON.stringify({ type: 'final', seq: 1, ts: 2, text: null, sig })), 'スキップした最後の一言')
  assert.equal(parsePeerMessage(JSON.stringify({ type: 'run', cmd: 'rm -rf /' })), null)
  assert.equal(parsePeerMessage(JSON.stringify({ type: 'hello', v: 1, lang: 'ja"; DROP' })), null)
  assert.equal(parsePeerMessage('x'.repeat(5000)), null)
})

test('署名は部屋・順番・本文に結びつき、改ざんすると通らない', async () => {
  const alice = keyPair()
  const roomId = randomId()
  const line = { type: 'chat' as const, seq: 3, ts: 1700, text: 'hello' }
  const sig = alice.sign(linePayload(roomId, line))
  assert.equal(await verifyEd25519(alice.pub, sig, linePayload(roomId, line)), true)
  assert.equal(await verifyEd25519(alice.pub, sig, linePayload(roomId, { ...line, text: 'hell0' })), false)
  assert.equal(await verifyEd25519(alice.pub, sig, linePayload(randomId(), line)), false)
  assert.equal(await verifyEd25519(keyPair().pub, sig, linePayload(roomId, line)), false)
})

test('通報本文は形を検証し、通報者の署名で守られる', async () => {
  const bob = keyPair()
  const roomId = randomId()
  const evidence = [{ type: 'chat' as const, seq: 1, ts: 2, text: 'spam', sig: toB64u(new Uint8Array(64)) }]
  const sig = bob.sign(reportPayload(roomId, 'abuse', evidence))
  const body = parseReportBody(JSON.stringify({ roomId, reporterKey: bob.pub, reason: 'abuse', evidence, sig }))
  assert.ok(body)
  assert.equal(await verifyEd25519(bob.pub, body.sig, reportPayload(roomId, body.reason, body.evidence)), true)
  assert.equal(await verifyEd25519(bob.pub, body.sig, reportPayload(roomId, 'spam', body.evidence)), false)
  assert.equal(parseReportBody(JSON.stringify({ roomId, reporterKey: bob.pub, reason: 'abuse', evidence: [{}], sig })), null)
})

test('proof-of-workは先頭のゼロビット数で判定する', async () => {
  assert.equal(leadingZeroBits(new Uint8Array([0, 0x0f, 0xff])), 12)
  assert.equal(leadingZeroBits(new Uint8Array([0x80])), 0)
  const { pub } = keyPair()
  const nonce = randomId()
  let found = ''
  for (let i = 0; i < 100_000 && !found; i += 1) {
    if (await checkPow(nonce, pub, i.toString(36), 8)) found = i.toString(36)
  }
  assert.ok(found, '8ビットなら必ず見つかる')
  assert.equal(await checkPow(nonce, pub, found, 8), true)
  assert.equal(await checkPow(randomId(), pub, found, 30), false)
})
