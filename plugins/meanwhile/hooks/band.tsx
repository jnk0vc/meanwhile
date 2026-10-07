// プロンプトの真上に出す帯(AbovePrompt)の描画。状態(View)から木を作るだけで、状態は書き換えない。
//
// 会話は別の窓を開かず、本体の画面の中で行う。相手の発言はこの帯に出し、自分の発言は本体の
// 入力欄に「>> 」で始めて送る。帯はトランスクリプトに入らないので、Claudeは読まず、手元にも残らない。

import type { Elements, RenderElement } from 'claude-code'

import type { Line, Phase, View } from '../types'
import { type Copy, copyFor, languageName } from './copy'

export type Display = 'both' | 'translated' | 'original'
export type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

export type Actions = {
  agree: () => void
  cancelConsent: () => void
  stopSearch: () => void
  reply: () => void
  skip: () => void
  leave: () => void
  block: () => void
  report: () => void
  reveal: (id: string) => void
  dismiss: () => void
}

type Kit = {
  Box: Elements['terminal']['Box']
  Text: Elements['terminal']['Text']
  Button: Elements['terminal']['Button']
}

// 本体のテーマに合わせる色はテーマキーで、Meanwhile独自の色だけ値で持つ。
// 相手は灯りの琥珀、原文はスレート、警告と締め切りはレンガ、会話中の印は苔色
const MUTED = 'inactive'
const NEEDS_YOU = 'permission'
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

/** 名前の列の幅。「Someone」(7セル)と「あなた」(6セル)に余白を足す */
const NAME_COLUMNS = 9

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

/** 相手の発言で大きく見せる文。翻訳があれば翻訳、なければ原文 */
function mainText(line: Line, display: Display): string {
  return display === 'original' || line.translation === 'none' || line.translated === null
    ? (line.text ?? '')
    : line.translated
}

/** 1通が帯の中で占める行数。本文の列は名前の列を除いた幅で折り返す */
export function lineRows(line: Line, columns: number, display: Display): number {
  const width = columns - NAME_COLUMNS
  const label = line.isFinal ? 1 : 0
  if (line.from === 'me' || line.text === null) return label + rowsOf(line.text ?? '-', width)
  if (line.flagged && !line.revealed) return label + 1
  const main = mainText(line, display)
  const original = display === 'both' && main !== line.text ? rowsOf(`│ ${line.text}`, width) : 0
  const status = line.translation === 'pending' || line.translation === 'failed' ? 1 : 0
  return label + rowsOf(main, width) + original + status + line.warnings.length
}

/**
 * 帯の高さに収まるだけ、新しい発言から逆順に選ぶ。
 * 1通も入らないほど狭ければ、最新の1通だけ出す(帯は溢れた分をスクロールで見せる)
 */
export function fitLines(lines: readonly Line[], rows: number, columns: number, display: Display): Line[] {
  const picked: Line[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const need = lineRows(lines[i]!, columns, display)
    if (picked.length > 0 && used + need > rows) break
    picked.unshift(lines[i]!)
    used += need
  }
  return picked
}

/**
 * 導火線。残り時間に合わせて琥珀の線が縮み、燃えている先端だけレンガ色にする。
 * マッチ開始までの待ちと、最後の一言の制限時間の両方に使う。
 */
export function fuse(remainingMs: number, spanMs: number, width: number): { lit: string; tip: string; burnt: string } {
  const cellsWide = Math.max(4, width)
  const ratio = spanMs > 0 ? Math.min(1, Math.max(0, remainingMs / spanMs)) : 0
  const lit = Math.round(ratio * (cellsWide - 1))
  return { lit: '━'.repeat(lit), tip: ratio > 0 ? '╸' : ' ', burnt: '╌'.repeat(cellsWide - 1 - lit) }
}

function Fuse(kit: Kit, view: View, now: number, columns: number, copy: Copy) {
  const { Box, Text } = kit
  if (view.deadline === null || view.span === null) return null
  const remaining = Math.max(0, view.deadline - now)
  const seconds = copy.seconds(Math.ceil(remaining / 1000))
  // 「秒」は全角で2セル。文字数で数えると1セルはみ出して折り返す
  const { lit, tip, burnt } = fuse(remaining, view.span, columns - cells(seconds) - 1)
  return (
    <Box key="fuse">
      <Text color={AMBER}>{lit}</Text>
      <Text color={BRICK}>{tip}</Text>
      <Text color={MUTED}>{burnt} </Text>
      <Text bold={view.phase === 'final'} color={view.phase === 'final' ? BRICK : undefined}>
        {seconds}
      </Text>
    </Box>
  )
}

/** 1行目: 状態の印・状態・右端の操作 */
function Head(kit: Kit, view: View, copy: Copy, status: string, buttons: RenderElement[]) {
  const { Box, Text } = kit
  return (
    <Box key="head" justifyContent="space-between">
      <Box flexShrink={1}>
        <Text color={DOT[view.phase]}>● </Text>
        <Text bold>meanwhile</Text>
        <Text color={MUTED} wrap="truncate-end">
          {' '}
          · {status}
        </Text>
      </Box>
      <Box gap={1} flexShrink={0}>
        {buttons}
      </Box>
    </Box>
  )
}

function LineView(kit: Kit, line: Line, copy: Copy, display: Display, actions: Actions) {
  const { Box, Text, Button } = kit
  const mine = line.from === 'me'
  const label = line.isFinal ? <Text color={MUTED}>{copy.lastWord}</Text> : null
  let body
  if (mine || line.text === null) {
    body = <Text color={line.text === null ? MUTED : undefined}>{line.text ?? copy.skippedLastWord}</Text>
  } else if (line.flagged && !line.revealed) {
    body = (
      <Box gap={1}>
        <Text color={MUTED} italic>
          {copy.hidden}
        </Text>
        <Button key={`reveal-${line.id}`} label={copy.show} plain onPress={() => actions.reveal(line.id)} />
      </Box>
    )
  } else {
    // 翻訳文を主に(既定色)、原文を引用の形で小さく(スレート)
    const main = mainText(line, display)
    const showOriginal = display === 'both' && main !== line.text
    const status =
      line.translation === 'pending' ? copy.translating : line.translation === 'failed' ? copy.translateFailed : null
    body = (
      <Box flexDirection="column">
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
  return (
    <Box key={line.id}>
      <Box width={NAME_COLUMNS} flexShrink={0}>
        <Text color={mine ? MUTED : AMBER} bold={!mine}>
          {mine ? copy.you : copy.someone}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {label}
        {body}
      </Box>
    </Box>
  )
}

export type BandInput = {
  kit: Kit
  view: View
  now: number
  columns: number
  /** 帯が丸ごと見せられる行数。これに収まるように発言を選ぶ */
  rows: number
  display: Display
  actions: Actions
}

/** 何も出さないときはnull。待機中・オフで知らせもないとき */
export function drawBand({ kit, view, now, columns, rows, display, actions }: BandInput) {
  const { Box, Text, Button } = kit
  const copy = copyFor(view.myLang)
  const width = Math.max(24, columns)
  // 主な操作(返信・同意)だけ本体の主ボタンの見た目にし、他は控えめな文字のボタンにする
  const button = (key: string, label: string, onPress: () => void, primary = false): RenderElement =>
    primary ? (
      <Button key={key} label={label} variant="primary" onPress={onPress} />
    ) : (
      <Button key={key} label={label} plain onPress={onPress} />
    )

  switch (view.phase) {
    case 'off':
      return null
    case 'consent':
      return (
        <Box flexDirection="column" width={width}>
          {Head(kit, view, copy, copy.consentTitle, [
            button('agree', copy.agree, actions.agree, true),
            button('cancel', copy.cancel, actions.cancelConsent),
          ])}
          {copy.consentPoints.map((point, i) => (
            <Box key={`point-${i}`}>
              <Text color={AMBER}>· </Text>
              <Text>{point}</Text>
            </Box>
          ))}
        </Box>
      )
    case 'idle':
      if (!view.notice) return null
      return (
        <Box flexDirection="column" width={width}>
          {Head(kit, view, copy, copy.notices[view.notice], [button('dismiss', copy.dismiss, actions.dismiss)])}
        </Box>
      )
    case 'working':
      return (
        <Box flexDirection="column" width={width}>
          {Head(kit, view, copy, copy.working, [button('stop', copy.stopSearch, actions.stopSearch)])}
          {Fuse(kit, view, now, width, copy)}
        </Box>
      )
    case 'queued':
    case 'connecting': {
      // 相手が先に去ったときは、その最後の一言を残したまま次の相手を探す
      const farewell = view.lines.map(line => LineView(kit, line, copy, display, actions))
      const after = view.lines.length > 0 ? [button('report-after', copy.report, actions.report), button('block-after', copy.block, actions.block)] : []
      const status = view.notice ? `${copy.notices[view.notice]} · ${copy.phaseLabel[view.phase]}` : copy.phaseLabel[view.phase]
      return (
        <Box flexDirection="column" width={width}>
          {Head(kit, view, copy, status, [...after, button('stop', copy.stopSearch, actions.stopSearch)])}
          {farewell}
        </Box>
      )
    }
    case 'chatting':
    case 'final': {
      const isFinal = view.phase === 'final'
      const langs = view.peerLang
        ? `${languageName(view.peerLang, view.myLang)} ⇄ ${languageName(view.myLang, view.myLang)}`
        : ''
      const status = isFinal ? copy.finalPrompt : `${copy.someone} · ${langs}`
      const buttons = [
        button('reply', copy.reply, actions.reply, true),
        isFinal ? button('skip', copy.skip, actions.skip) : button('leave', copy.leave, actions.leave),
        button('block', copy.block, actions.block),
        button('report', copy.report, actions.report),
      ]
      // 1行目・導火線・案内・バナーを除いた残りに、新しい発言から詰める
      const fixed = 2 + (isFinal ? 1 : 0) + (view.needsYou ? 1 : 0) + (view.notice ? 1 : 0)
      const shown = fitLines(view.lines, rows - fixed, width, display)
      return (
        <Box flexDirection="column" width={width}>
          {Head(kit, view, copy, status, buttons)}
          {isFinal ? Fuse(kit, view, now, width, copy) : null}
          {view.needsYou ? (
            <Text color={NEEDS_YOU} bold>
              ! {copy.needsYou}
            </Text>
          ) : null}
          {view.lines.length === 0 ? <Text color={MUTED}>{copy.connectedHint}</Text> : null}
          {shown.map(line => LineView(kit, line, copy, display, actions))}
          <Text color={MUTED} wrap="truncate-end">
            {isFinal ? copy.bandFinalHint : copy.bandHint}
          </Text>
        </Box>
      )
    }
  }
}
