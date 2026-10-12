// つながったときとメッセージが届いたときの音。音のファイルは同梱せず、ここで波形を作る。
// 880Hzの音のあとに1320Hzの音が続く2音で、どちらも鳴ってすぐに減衰する

const SAMPLE_RATE = 22_050
// クリック音が出ないよう、鳴り始めを少しだけなだらかにする
const ATTACK = 0.002
// 減衰を始めるまで同じ音量を保つ時間
const HOLD = 0.01

type Note = {
  hz: number
  /** 鳴り始めと鳴り終わり(秒) */
  start: number
  end: number
  /** 最大の音量(1が上限) */
  gain: number
  /** 音量が1/eになるまでの秒数 */
  decay: number
}

const NOTES: readonly Note[] = [
  { hz: 880, start: 0, end: 0.09, gain: 0.23, decay: 0.022 },
  { hz: 1320, start: 0.09, end: 0.23, gain: 0.265, decay: 0.035 },
]

/** 16bitモノラルのPCMサンプル */
export function chimeSamples(): Int16Array {
  const total = Math.round(SAMPLE_RATE * Math.max(...NOTES.map(note => note.end)))
  const samples = new Int16Array(total)
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE
    let value = 0
    for (const note of NOTES) {
      if (t < note.start || t >= note.end) continue
      const local = t - note.start
      const envelope = Math.min(1, local / ATTACK) * Math.exp(-Math.max(0, local - HOLD) / note.decay)
      value += note.gain * envelope * Math.sin(2 * Math.PI * note.hz * local)
    }
    samples[i] = Math.round(Math.max(-1, Math.min(1, value)) * 32_767)
  }
  return samples
}

/** PCMサンプルを、ヘッダー付きのWAV(RIFF)のバイト列にする */
export function wavBytes(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataSize = samples.length * 2
  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // リニアPCM
  view.setUint16(22, 1, true) // モノラル
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true))
  return bytes
}

let cached: string | undefined

/** $.audio.playに渡すWAVのBase64。初めて鳴らすときに作り、あとは使い回す */
export function chimeBase64(): string {
  if (cached === undefined) {
    let binary = ''
    for (const byte of wavBytes(chimeSamples())) binary += String.fromCharCode(byte)
    cached = btoa(binary)
  }
  return cached
}
