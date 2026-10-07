import { createHash, generateKeyPairSync, sign } from 'node:crypto'

import { leadingZeroBits, powInput, toB64u } from '../../shared/wire.ts'

/**
 * このサイドカー(= Claude Codeの1セッション)だけで使うEd25519の鍵。
 * 匿名性を優先し、インストールごとには固定せず、起動のたびに作り直す。
 */
export type Identity = {
  publicKey: string
  sign: (data: Uint8Array) => string
}

export function createIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('Ed25519の公開鍵を取り出せませんでした')
  return {
    publicKey: jwk.x,
    sign: data => toB64u(sign(null, data, privateKey)),
  }
}

/**
 * サーバーが求めるproof-of-workを解く。期待値で2^bits回のハッシュ計算になる。
 * 18ビットなら手元のMacで0.3秒ほど。
 */
export function solvePow(nonce: string, pubkey: string, bits: number, limit = 1 << 26): string {
  for (let i = 0; i < limit; i += 1) {
    const pow = i.toString(36)
    const digest = createHash('sha256').update(powInput(nonce, pubkey, pow)).digest()
    if (leadingZeroBits(digest) >= bits) return pow
  }
  throw new Error('proof-of-workが上限回数までに解けませんでした')
}
