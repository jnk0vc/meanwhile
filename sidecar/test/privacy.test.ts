import assert from 'node:assert/strict'
import { networkInterfaces } from 'node:os'
import { test } from 'node:test'

import { RTCPeerConnection } from 'werift'

import { scrubCandidate, scrubSdp } from '../src/privacy.ts'

const HOST = 'candidate:73fa5277 1 udp 2116026367 192.168.10.23 58750 typ host generation 0 ufrag 7fc5'
const SRFLX = 'candidate:8043f810 1 udp 1679818751 203.0.113.7 8981 typ srflx raddr 192.168.10.23 rport 58750'

test('LAN内のアドレスそのもの(host候補)は相手に渡さない', () => {
  assert.equal(scrubCandidate(HOST), null)
  assert.equal(scrubCandidate('candidate:1 1 udp 1 fd00::1 5000 typ host'), null)
  assert.equal(scrubCandidate('candidate:1 1 udp 1 1.2.3.4 5000'), null, 'typが無い候補も捨てる')
})

test('外向きの候補(srflx)は残し、元のLANアドレス(raddr / rport)は0.0.0.0 / 0にする', () => {
  assert.equal(scrubCandidate(SRFLX), 'candidate:8043f810 1 udp 1679818751 203.0.113.7 8981 typ srflx raddr 0.0.0.0 rport 0')
})

test('SDPに埋め込まれた候補も同じように消し、他の行と改行は保つ', () => {
  const sdp = ['v=0', 'c=IN IP4 0.0.0.0', `a=${HOST}`, `a=${SRFLX}`, 'a=end-of-candidates', ''].join('\r\n')
  const scrubbed = scrubSdp(sdp)
  assert.equal(
    scrubbed,
    ['v=0', 'c=IN IP4 0.0.0.0', 'a=candidate:8043f810 1 udp 1679818751 203.0.113.7 8981 typ srflx raddr 0.0.0.0 rport 0', 'a=end-of-candidates', ''].join('\r\n'),
  )
  assert.ok(!scrubbed.includes('192.168.'))
})

test('weriftが実際に作るSDPから、このマシンのアドレスが1つも残らない', async () => {
  // STUNを使わずに候補を集めるので、hostだけが入ったSDPになる(ネットワーク不要)
  const pc = new RTCPeerConnection({ iceServers: [] })
  pc.createDataChannel('probe')
  await pc.setLocalDescription(await pc.createOffer())
  const raw = pc.localDescription!.sdp
  await pc.close()

  const mine = Object.values(networkInterfaces())
    .flat()
    .map(info => info?.address)
    .filter((address): address is string => !!address && address !== '127.0.0.1' && address !== '::1')
  assert.ok(mine.some(address => raw.includes(address)), '前提: 加工前のSDPにはこのマシンのアドレスが入っている')

  const scrubbed = scrubSdp(raw)
  for (const address of mine) assert.ok(!scrubbed.includes(address), `${address.split('.')[0]}… が残っている`)
  assert.ok(!/a=candidate:.* typ host/.test(scrubbed))
})
