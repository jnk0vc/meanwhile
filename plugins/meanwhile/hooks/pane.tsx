// サイドパネルの描画。状態(View)から木を作るだけで、状態は書き換えない。
// 押されたときの処理はActionsとしてregister.tsxから受け取る。
//
// 見た目はClaude Code本体の画面にそろえる。相手の発言は本体の応答と同じく左に地の文で、
// 自分の発言は本体のユーザー発言と同じく右寄せの角丸の囲みで、入力欄は本体と同じ角丸の枠で描く。

import type { Elements } from 'claude-code'

import type { Line, Phase, View } from '../types'
import { type Copy, copyFor, languageName } from './copy'

export type Display = 'both' | 'translated' | 'original'
export type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

export type Actions = {
  agree: () => void
  askConsent: () => void
  cancelConsent: () => void
  disable: () => void
  stopSearch: () => void
  say: (text: string) => void
  sayLast: (text: string | null) => void
  leave: () => void
  block: () => void
  report: () => void
  reveal: (id: string) => void
}

type Kit = {
  Box: Elements['terminal']['Box']
  Text: Elements['terminal']['Text']
  Button: Elements['terminal']['Button']
  Input?: Elements['terminal']['Input']
}

// 本体のテーマに合わせる色はテーマキーで、Meanwhile独自の色だけ値で持つ。
// 相手は灯りの琥珀、原文はスレート、警告と締め切りはレンガ、会話中の印は苔色
const BORDER = 'promptBorder'
const MUTED = 'inactive'
const NEEDS_YOU = 'permission'
const BUBBLE = 'userMessageBackground'
const AMBER = '#d7a35f'
const SLATE = '#8a94a6'
const BRICK = '#d75f5f'
const MOSS = '#8fbf7f'

const DOT: Record<Phase, string> = {
  off: MUTED,
  consent: MUTED,
  idle: MUTED,
  working: AMBER,
  queued: AMBER,
  connecting: AMBER,
  chatting: MOSS,
  final: BRICK,
}

/**
 * 導火線。残り時間に合わせて琥珀の線が縮み、燃えている先端だけレンガ色にする。
 * マッチ開始までの待ちと、最後の一言の制限時間の両方に使う。
 */
export function fuse(remainingMs: number, spanMs: number, width: number): { lit: string; tip: string; burnt: string } {
  const cells = Math.max(4, width)
  const ratio = spanMs > 0 ? Math.min(1, Math.max(0, remainingMs / spanMs)) : 0
  const lit = Math.round(ratio * (cells - 1))
  return { lit: '━'.repeat(lit), tip: ratio > 0 ? '╸' : ' ', burnt: '╌'.repeat(cells - 1 - lit) }
}

/** 端末での表示幅。全角(CJK・かな・全角記号)と絵文字は2セルと数える */
export function cells(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    width += wide ? 2 : 1
  }
  return width
}

const rowsOf = (text: string, columns: number) =>
  text.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(cells(part) / Math.max(1, columns))), 0)

/** 1通が占めるおおよその行数(前の余白1行を含む) */
export function lineRows(line: Line, columns: number, display: Display, surface: Surface): number {
  if (line.from === 'me') {
    const frame = surface === 'terminal' ? 2 : 0
    return 1 + (line.isFinal ? 1 : 0) + frame + rowsOf(line.text ?? '', columns - 4)
  }
  if (line.text === null || (line.flagged && !line.revealed)) return 3
  const main = display === 'original' || line.translated === null ? line.text : line.translated
  const original = display === 'both' && main !== line.text ? rowsOf(`│ ${line.text}`, columns) : 0
  const status = line.translation === 'pending' || line.translation === 'failed' ? 1 : 0
  return 2 + rowsOf(main, columns) + original + status + line.warnings.length
}

/**
 * 本文の高さに収まるだけ、新しい発言から逆順に選ぶ。入力欄を見切れさせないため、
 * 1通も入らないほど狭ければ発言は出さない(入力欄が優先)
 */
export function fitLines(lines: readonly Line[], rows: number, columns: number, display: Display, surface: Surface): Line[] {
  const picked: Line[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const need = lineRows(lines[i]!, columns, display, surface)
    if (used + need > rows) break
    picked.unshift(lines[i]!)
    used += need
  }
  return picked
}

function Header(kit: Kit, view: View, copy: Copy) {
  const { Box, Text } = kit
  const talking = (view.phase === 'chatting' || view.phase === 'final') && view.peerLang
  const right = talking
    ? `${languageName(view.peerLang!, view.myLang)} ⇄ ${languageName(view.myLang, view.myLang)}`
    : copy.phaseLabel[view.phase]
  return (
    <Box key="header" flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text color={DOT[view.phase]}>● </Text>
          <Text bold>meanwhile</Text>
        </Box>
        <Text color={MUTED}>{right}</Text>
      </Box>
      <Text color={MUTED}>{copy.shareNote}</Text>
    </Box>
  )
}

function Fuse(kit: Kit, view: View, now: number, columns: number, copy: Copy) {
  const { Box, Text } = kit
  if (view.deadline === null || view.span === null) return null
  const remaining = Math.max(0, view.deadline - now)
  const seconds = copy.seconds(Math.ceil(remaining / 1000))
  // 「秒」は全角で2セル。文字数で数えると1セルはみ出して折り返す
  const { lit, tip, burnt } = fuse(remaining, view.span, columns - cells(seconds) - 1)
  return (
    <Box key="fuse" marginTop={1}>
      <Text color={AMBER}>{lit}</Text>
      <Text color={BRICK}>{tip}</Text>
      <Text color={MUTED}>{burnt} </Text>
      <Text bold={view.phase === 'final'} color={view.phase === 'final' ? BRICK : undefined}>
        {seconds}
      </Text>
    </Box>
  )
}

function Mine(kit: Kit, line: Line, copy: Copy, surface: Surface) {
  const { Box, Text } = kit
  // デスクトップは本体のユーザー発言と同じ塗りの囲み、端末は角丸の枠
  const bubble =
    surface === 'terminal' ? { borderStyle: 'round', borderColor: BORDER } : { backgroundColor: BUBBLE, paddingY: 0 }
  return (
    <Box key={line.id} flexDirection="column" alignItems="flex-end" marginTop={1}>
      {line.isFinal ? <Text color={MUTED}>{copy.lastWord}</Text> : null}
      <Box {...bubble} paddingX={1}>
        <Text>{line.text ?? copy.skippedLastWord}</Text>
      </Box>
    </Box>
  )
}

function Theirs(kit: Kit, line: Line, copy: Copy, display: Display, actions: Actions) {
  const { Box, Text, Button } = kit
  const name = (
    <Box>
      <Text color={AMBER} bold>
        {copy.someone}
      </Text>
      {line.isFinal ? <Text color={MUTED}> · {copy.lastWord}</Text> : null}
    </Box>
  )
  if (line.text === null) {
    return (
      <Box key={line.id} flexDirection="column" marginTop={1}>
        {name}
        <Text color={MUTED}>{copy.skippedLastWord}</Text>
      </Box>
    )
  }
  if (line.flagged && !line.revealed) {
    return (
      <Box key={line.id} flexDirection="column" marginTop={1}>
        {name}
        <Box gap={1}>
          <Text color={MUTED} italic>
            {copy.hidden}
          </Text>
          <Button key={`reveal-${line.id}`} label={copy.show} plain onPress={() => actions.reveal(line.id)} />
        </Box>
      </Box>
    )
  }

  // 翻訳文を大きく(既定色)、原文を小さく(スレートの引用)。翻訳が無ければ原文を主にする
  const main =
    display === 'original' || line.translation === 'none' || line.translated === null ? line.text : line.translated
  const showOriginal = display === 'both' && main !== line.text
  const status =
    line.translation === 'pending' ? copy.translating : line.translation === 'failed' ? copy.translateFailed : null
  return (
    <Box key={line.id} flexDirection="column" marginTop={1}>
      {name}
      <Text>{main}</Text>
      {showOriginal ? <Text color={SLATE}>│ {line.text}</Text> : null}
      {status ? (
        <Text color={MUTED} italic>
          {status}
        </Text>
      ) : null}
      {line.warnings.includes('command') ? <Text color={BRICK}>{copy.commandWarning}</Text> : null}
      {line.warnings.includes('url') ? <Text color={BRICK}>{copy.urlWarning}</Text> : null}
    </Box>
  )
}

function LineView(kit: Kit, line: Line, copy: Copy, display: Display, surface: Surface, actions: Actions) {
  return line.from === 'me' ? Mine(kit, line, copy, surface) : Theirs(kit, line, copy, display, actions)
}

/**
 * 入力欄。端末は本体の入力欄と同じく上下の横線の間に「❯ 」を置き、最後の一言のあいだは
 * 線を締め切りの色にする。デスクトップの入力欄はネイティブで枠を持つので、外枠は付けない
 */
function Composer(kit: Kit, view: View, copy: Copy, surface: Surface, columns: number, actions: Actions) {
  const { Box, Text, Button, Input } = kit
  const isFinal = view.phase === 'final'
  const field = Input ? (
    <Box flexGrow={1}>
      <Input
        key={`say-${view.inputGen}`}
        placeholder={isFinal ? copy.finalPlaceholder : copy.placeholder}
        value={view.draft}
        submitLabel={surface === 'terminal' ? undefined : '↑'}
        autoFocus
        onSubmit={text => (isFinal ? actions.sayLast(text) : actions.say(text))}
      />
    </Box>
  ) : (
    <Text color={MUTED}>{copy.noInputHere}</Text>
  )
  const framed = surface === 'terminal'
  return (
    <Box key="composer" flexDirection="column" marginTop={1}>
      {view.draftWarning ? <Text color={BRICK}>{copy.draft[view.draftWarning]}</Text> : null}
      {framed ? (
        <Box flexDirection="column">
          <Text color={isFinal ? BRICK : BORDER}>{'─'.repeat(columns)}</Text>
          <Box>
            <Text color={isFinal ? BRICK : undefined}>{'❯ '}</Text>
            {field}
          </Box>
          <Text color={isFinal ? BRICK : BORDER}>{'─'.repeat(columns)}</Text>
        </Box>
      ) : (
        <Box>{field}</Box>
      )}
      <Box justifyContent={framed ? 'space-between' : 'flex-end'} paddingX={framed ? 2 : 0}>
        {framed ? <Text color={MUTED}>{isFinal ? copy.finalHint : copy.sendHint}</Text> : null}
        <Box gap={1}>
          {isFinal ? (
            <Button key="skip" label={copy.skip} plain onPress={() => actions.sayLast(null)} />
          ) : (
            <Button key="leave" label={copy.leave} plain onPress={actions.leave} />
          )}
          <Button key="block" label={copy.block} plain onPress={actions.block} />
          <Button key="report" label={copy.report} plain onPress={actions.report} />
        </Box>
      </Box>
    </Box>
  )
}

export type PaneInput = {
  kit: Kit
  view: View
  now: number
  columns: number
  /** ペインの本文が見せられる行数。これに収まるように発言を選ぶ */
  rows: number
  surface: Surface
  display: Display
  matchDelaySeconds: number
  actions: Actions
}

export function drawPane({ kit, view, now, columns, rows, surface, display, matchDelaySeconds, actions }: PaneInput) {
  const { Box, Text, Button } = kit
  const copy = copyFor(view.myLang)
  const width = Math.max(24, columns)

  const banner = view.needsYou ? (
    <Box key="needs-you" borderStyle="round" borderColor={NEEDS_YOU} paddingX={1} marginTop={1}>
      <Text color={NEEDS_YOU} bold>
        !{' '}
      </Text>
      <Text>{copy.needsYou}</Text>
    </Box>
  ) : null
  const notice = view.notice ? (
    <Box key="notice" marginTop={1}>
      <Text color={MUTED} italic>
        {copy.notices[view.notice]}
      </Text>
    </Box>
  ) : null

  let body
  switch (view.phase) {
    case 'off':
      body = (
        <Box key="off" flexDirection="column" marginTop={1}>
          <Text>{copy.off}</Text>
          <Box marginTop={1}>
            <Button key="turn-on" label={copy.turnOn} variant="primary" onPress={actions.askConsent} />
          </Box>
        </Box>
      )
      break
    case 'consent':
      body = (
        <Box key="consent" flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1} marginTop={1}>
          {/* 端末のパネルは低いので、操作を見出しの行に置いて見切れないようにする */}
          <Box justifyContent="space-between" flexWrap="wrap" gap={1}>
            <Text bold>{copy.consentTitle}</Text>
            <Box gap={1}>
              <Button key="agree" label={copy.agree} variant="primary" autoFocus onPress={actions.agree} />
              <Button key="cancel" label={copy.cancel} onPress={actions.cancelConsent} />
            </Box>
          </Box>
          {copy.consentPoints.map((point, i) => (
            <Box key={`point-${i}`}>
              <Text color={AMBER}>· </Text>
              <Text>{point}</Text>
            </Box>
          ))}
        </Box>
      )
      break
    case 'idle':
    case 'working':
    case 'queued':
    case 'connecting': {
      const status =
        view.phase === 'idle'
          ? view.isPaused
            ? copy.paused
            : copy.idle(matchDelaySeconds)
          : view.phase === 'working'
            ? copy.working
            : view.phase === 'queued'
              ? copy.queued
              : copy.connecting
      // 相手の最後の一言は、次の相手を探している間も残す
      const farewell = view.lines.map(line => LineView(kit, line, copy, display, surface, actions))
      const canReport = view.lines.some(line => line.from === 'peer')
      body = (
        <Box key="waiting" flexDirection="column">
          {view.phase === 'working' ? Fuse(kit, view, now, width, copy) : null}
          <Box marginTop={1}>
            <Text color={view.phase === 'idle' ? MUTED : undefined}>{status}</Text>
          </Box>
          {farewell}
          <Box gap={1} marginTop={1}>
            {view.phase === 'idle' ? (
              <Button key="turn-off" label={copy.turnOff} plain onPress={actions.disable} />
            ) : (
              <Button key="stop" label={copy.stopSearch} plain onPress={actions.stopSearch} />
            )}
            {canReport ? <Button key="report-after" label={copy.report} plain onPress={actions.report} /> : null}
            {canReport ? <Button key="block-after" label={copy.block} plain onPress={actions.block} /> : null}
          </Box>
        </Box>
      )
      break
    }
    case 'chatting':
    case 'final': {
      // 見出し・バナー・導火線・入力欄の行を除いた残りに、新しい発言から詰める
      const fixed =
        2 +
        (view.needsYou ? 4 : 0) +
        (view.notice ? 2 : 0) +
        (view.phase === 'final' ? 4 : view.lines.length === 0 ? 2 : 0) +
        (view.draftWarning ? 1 : 0) +
        (surface === 'terminal' ? 5 : 3)
      const shown = fitLines(view.lines, rows - fixed, width, display, surface)
      body = (
        <Box key="chat" flexDirection="column">
          {view.phase === 'final' ? Fuse(kit, view, now, width, copy) : null}
          {view.phase === 'final' ? (
            <Box marginTop={1}>
              <Text bold>{copy.finalPrompt}</Text>
            </Box>
          ) : view.lines.length === 0 ? (
            <Box marginTop={1}>
              <Text color={MUTED}>{copy.connectedHint}</Text>
            </Box>
          ) : null}
          {shown.map(line => LineView(kit, line, copy, display, surface, actions))}
          {Composer(kit, view, copy, surface, width, actions)}
        </Box>
      )
      break
    }
  }

  return (
    <Box flexDirection="column" width={width}>
      {Header(kit, view, copy)}
      {banner}
      {notice}
      {body}
    </Box>
  )
}
