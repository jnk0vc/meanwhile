// 相手に渡す接続情報から、LAN内のアドレスを消す。
// 相手に見えてよいのは、STUNで分かる外向きのアドレス(srflx)だけにする。
// ブラウザのWebRTCがmDNSでLAN内のアドレスを隠すのと同じ目的で、weriftはそのまま送るため自前で消す。

const CANDIDATE_LINE = /^a=(candidate:.*)$/

/**
 * ICE候補を1つ相手に渡せる形にする。LAN内のアドレスそのもの(host)は捨て、
 * srflx・relayに付く元のアドレス(raddr / rport)は0.0.0.0 / 0に書き換える。
 */
export function scrubCandidate(candidate: string): string | null {
  const fields = candidate.trim().split(/\s+/)
  const typ = fields[fields.indexOf('typ') + 1]
  if (fields.indexOf('typ') === -1 || (typ !== 'srflx' && typ !== 'relay')) return null
  const raddr = fields.indexOf('raddr')
  if (raddr !== -1 && raddr + 1 < fields.length) fields[raddr + 1] = '0.0.0.0'
  const rport = fields.indexOf('rport')
  if (rport !== -1 && rport + 1 < fields.length) fields[rport + 1] = '0'
  return fields.join(' ')
}

/** SDPに埋め込まれた候補にも同じ処理をする。weriftは候補を集め終えてからSDPを作るため */
export function scrubSdp(sdp: string): string {
  const newline = sdp.includes('\r\n') ? '\r\n' : '\n'
  return sdp
    .split(newline)
    .flatMap(line => {
      const match = CANDIDATE_LINE.exec(line)
      if (!match) return [line]
      const scrubbed = scrubCandidate(match[1]!)
      return scrubbed === null ? [] : [`a=${scrubbed}`]
    })
    .join(newline)
}
