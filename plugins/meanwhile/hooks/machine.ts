// 状態遷移。副作用(サイドカーへの指示・タイマー・翻訳)はEffectとして返し、
// 実行はregister.tsxが受け持つ。ここは純粋な関数だけにしてテストする。

import type { Line, Notice, View, Warning } from '../types'

export type Settings = {
  matchDelayMs: number
  finalMs: number
}

export type MachineEvent =
  | { type: 'ask-consent' }
  | { type: 'cancel-consent' }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'work-start'; now: number }
  | { type: 'work-end'; now: number }
  | { type: 'match-delay-passed' }
  | { type: 'retry' }
  | { type: 'matched' }
  | { type: 'connected'; lang: string }
  | { type: 'connect-failed' }
  | { type: 'peer-chat'; id: string; text: string; warnings: Warning[]; now: number }
  | { type: 'peer-final'; id: string; text: string | null; warnings: Warning[]; now: number }
  | { type: 'peer-left'; reason: 'done' | 'blocked' | 'lost' }
  | { type: 'translated'; id: string; text: string; flagged: boolean }
  | { type: 'translate-failed'; id: string }
  | { type: 'flag'; id: string }
  | { type: 'reveal'; id: string }
  | { type: 'my-chat'; id: string; text: string; now: number }
  | { type: 'my-final'; text: string | null }
  | { type: 'final-timeout' }
  | { type: 'leave' }
  | { type: 'block' }
  | { type: 'report' }
  | { type: 'stop-search' }
  | { type: 'trouble'; notice: Notice; retry: boolean }
  | { type: 'needs-you'; value: boolean }
  | { type: 'dismiss-notice' }

export type Effect =
  | { do: 'join' }
  | { do: 'leave' }
  | { do: 'send'; text: string }
  | { do: 'final'; text: string | null }
  | { do: 'block' }
  | { do: 'report' }
  | { do: 'arm'; ms: number; timer: 'match' | 'final' | 'retry' }
  | { do: 'disarm' }
  | { do: 'translate'; id: string; text: string }
  | { do: 'moderate'; id: string; text: string }
  | { do: 'announce' }
  | { do: 'chime' }
  | { do: 'save-enabled'; value: boolean }

export const MAX_LINES = 60
export const RETRY_MS = 15_000

export function initialView(myLang: string, enabled: boolean): View {
  return {
    phase: enabled ? 'idle' : 'off',
    isWorking: false,
    isPaused: false,
    myLang,
    peerLang: null,
    lines: [],
    deadline: null,
    span: null,
    needsYou: false,
    notice: null,
  }
}

const sameLanguage = (a: string, b: string | null) => b !== null && a.split('-')[0] === b.split('-')[0]

/** 会話の部屋を出たあとの共通処理。ログは消し、作業中なら次の相手を探しに戻る */
function afterRoom(view: View, notice: Notice | null): [View, Effect[]] {
  const base: View = { ...view, lines: [], peerLang: null, deadline: null, span: null, notice }
  if (view.isWorking && !view.isPaused) return [{ ...base, phase: 'queued' }, [{ do: 'disarm' }, { do: 'join' }]]
  return [{ ...base, phase: 'idle' }, [{ do: 'disarm' }]]
}

function updateLine(view: View, id: string, patch: Partial<Line>): View {
  return { ...view, lines: view.lines.map(line => (line.id === id ? { ...line, ...patch } : line)) }
}

function peerLine(view: View, id: string, text: string | null, warnings: Warning[], now: number, isFinal: boolean): [Line, Effect[]] {
  const needsTranslation = text !== null && !sameLanguage(view.myLang, view.peerLang)
  const line: Line = {
    id,
    from: 'peer',
    text,
    translated: null,
    translation: needsTranslation ? 'pending' : 'none',
    flagged: false,
    revealed: false,
    warnings,
    isFinal,
    at: now,
  }
  if (text === null) return [line, []]
  return [line, [needsTranslation ? { do: 'translate', id, text } : { do: 'moderate', id, text }]]
}

export function reduce(view: View, event: MachineEvent, settings: Settings): [View, Effect[]] {
  switch (event.type) {
    case 'ask-consent':
      return view.phase === 'off' ? [{ ...view, phase: 'consent' }, []] : [view, []]
    case 'cancel-consent':
      return view.phase === 'consent' ? [{ ...view, phase: 'off' }, []] : [view, []]
    case 'enable':
      if (view.phase !== 'off' && view.phase !== 'consent') return [view, []]
      return [{ ...view, phase: 'idle', notice: null, isPaused: false }, [{ do: 'save-enabled', value: true }]]
    case 'disable': {
      const effects: Effect[] = [{ do: 'disarm' }, { do: 'save-enabled', value: false }]
      if (view.phase === 'chatting' || view.phase === 'final') effects.push({ do: 'final', text: null })
      else if (view.phase === 'queued' || view.phase === 'connecting') effects.push({ do: 'leave' })
      return [{ ...initialView(view.myLang, false), isWorking: view.isWorking }, effects]
    }

    case 'work-start': {
      const working = { ...view, isWorking: true, isPaused: false, needsYou: false }
      if (view.phase === 'idle') {
        return [
          { ...working, phase: 'working', deadline: event.now + settings.matchDelayMs, span: settings.matchDelayMs, notice: null },
          [{ do: 'arm', ms: settings.matchDelayMs, timer: 'match' }],
        ]
      }
      // 最後の一言を書く前に次のプロンプトを送ったなら、会話を続ける
      if (view.phase === 'final') return [{ ...working, phase: 'chatting', deadline: null, span: null }, [{ do: 'disarm' }]]
      return [working, []]
    }
    case 'work-end': {
      const done = { ...view, isWorking: false, needsYou: false }
      switch (view.phase) {
        case 'working':
          return [{ ...done, phase: 'idle', deadline: null, span: null }, [{ do: 'disarm' }]]
        case 'queued':
        case 'connecting':
          // マッチ待ち中に作業が終わったら、何も出さずに待機へ
          return [{ ...done, phase: 'idle', deadline: null, span: null }, [{ do: 'disarm' }, { do: 'leave' }]]
        case 'chatting':
          return [
            { ...done, phase: 'final', deadline: event.now + settings.finalMs, span: settings.finalMs },
            [{ do: 'arm', ms: settings.finalMs, timer: 'final' }, { do: 'announce' }],
          ]
        default:
          return [{ ...done, isPaused: false }, []]
      }
    }
    case 'match-delay-passed':
      if (view.phase !== 'working') return [view, []]
      return [{ ...view, phase: 'queued', deadline: null, span: null }, [{ do: 'join' }]]
    case 'retry':
      return view.phase === 'queued' && view.isWorking ? [view, [{ do: 'join' }]] : [view, []]

    case 'matched':
      return view.phase === 'queued' ? [{ ...view, phase: 'connecting' }, []] : [view, []]
    case 'connected':
      // 退室を指示したあとに遅れて届いた接続は、そのまま閉じる
      if (view.phase !== 'queued' && view.phase !== 'connecting') return [view, [{ do: 'leave' }]]
      return [
        { ...view, phase: 'chatting', peerLang: event.lang, lines: [], notice: null },
        [{ do: 'announce' }, { do: 'chime' }],
      ]
    case 'connect-failed':
      if (view.phase !== 'queued' && view.phase !== 'connecting') return [view, []]
      return view.isWorking ? [{ ...view, phase: 'queued' }, [{ do: 'join' }]] : [{ ...view, phase: 'idle' }, []]

    case 'peer-chat': {
      if (view.phase !== 'chatting' && view.phase !== 'final') return [view, []]
      const [line, effects] = peerLine(view, event.id, event.text, event.warnings, event.now, false)
      return [{ ...view, lines: [...view.lines, line].slice(-MAX_LINES) }, [...effects, { do: 'chime' }]]
    }
    case 'peer-final': {
      if (view.phase !== 'chatting' && view.phase !== 'final') return [view, []]
      const [line, effects] = peerLine(view, event.id, event.text, event.warnings, event.now, true)
      // 相手の最後の一言は、次の相手を探している間も見えるように残す
      const [next, roomEffects] = afterRoom(view, 'peer-done')
      return [{ ...next, lines: [line] }, [...roomEffects, ...effects]]
    }
    case 'peer-left': {
      if (view.phase !== 'chatting' && view.phase !== 'final') return [view, []]
      const notice: Notice = event.reason === 'done' ? 'peer-done' : event.reason === 'blocked' ? 'peer-blocked' : 'peer-lost'
      if (view.phase === 'final') return [{ ...afterRoom(view, notice)[0], phase: 'idle' }, [{ do: 'disarm' }]]
      return afterRoom(view, notice)
    }

    case 'translated':
      return [updateLine(view, event.id, { translated: event.text, translation: 'done', flagged: event.flagged }), []]
    case 'translate-failed':
      return [updateLine(view, event.id, { translation: 'failed' }), []]
    case 'flag':
      return [updateLine(view, event.id, { flagged: true }), []]
    case 'reveal':
      return [updateLine(view, event.id, { revealed: true }), []]

    case 'my-chat': {
      if (view.phase !== 'chatting') return [view, []]
      const line: Line = {
        id: event.id,
        from: 'me',
        text: event.text,
        translated: null,
        translation: 'none',
        flagged: false,
        revealed: false,
        warnings: [],
        isFinal: false,
        at: event.now,
      }
      return [
        { ...view, lines: [...view.lines, line].slice(-MAX_LINES) },
        [{ do: 'send', text: event.text }],
      ]
    }
    case 'my-final':
    case 'final-timeout': {
      if (view.phase !== 'final') return [view, []]
      const text = event.type === 'my-final' ? event.text : null
      return [
        { ...afterRoom(view, 'you-left')[0], phase: 'idle' },
        [{ do: 'disarm' }, { do: 'final', text }],
      ]
    }

    case 'leave': {
      if (view.phase === 'chatting' || view.phase === 'final') {
        return [{ ...afterRoom({ ...view, isPaused: true }, 'you-left')[0], isPaused: true }, [{ do: 'disarm' }, { do: 'leave' }]]
      }
      return [view, []]
    }
    case 'stop-search':
      if (view.phase !== 'working' && view.phase !== 'queued' && view.phase !== 'connecting') return [view, []]
      return [{ ...view, phase: 'idle', isPaused: true, deadline: null, span: null }, [{ do: 'disarm' }, { do: 'leave' }]]
    case 'block':
    case 'report': {
      const effect: Effect = event.type === 'block' ? { do: 'block' } : { do: 'report' }
      const notice: Notice = event.type === 'block' ? 'blocked' : 'reported'
      if (view.phase !== 'chatting' && view.phase !== 'final') {
        // 相手が去ったあとに残った最後の一言からも通報・ブロックできる
        return view.lines.length === 0 ? [view, []] : [{ ...view, lines: [], notice }, [effect]]
      }
      const [next, effects] = afterRoom(view, notice)
      // 通報・ブロックはサイドカー側で即切断する。そのあとで次の相手を探す
      return [next, [effect, ...effects]]
    }

    case 'trouble': {
      const searching = view.phase === 'queued' || view.phase === 'connecting'
      if (event.retry && searching && view.isWorking) {
        return [{ ...view, phase: 'queued', notice: event.notice }, [{ do: 'arm', ms: RETRY_MS, timer: 'retry' }]]
      }
      const phase = view.phase === 'off' || view.phase === 'consent' ? view.phase : 'idle'
      const effects: Effect[] = [{ do: 'disarm' }]
      if (view.phase === 'chatting' || view.phase === 'final') effects.push({ do: 'final', text: null })
      return [{ ...view, phase, notice: event.notice, lines: [], peerLang: null, deadline: null, span: null, isPaused: true }, effects]
    }
    case 'needs-you':
      return [{ ...view, needsYou: event.value }, []]
    case 'dismiss-notice':
      return [{ ...view, notice: null }, []]
  }
}
