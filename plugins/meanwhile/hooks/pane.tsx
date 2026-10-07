// サイドパネルの描画。状態(View)から木を作るだけで、状態は書き換えない。
// 押されたときの処理はActionsとしてregister.tsxから受け取る。

import type { Elements } from 'claude-code'

import type { Line, View } from '../types'
import { type Copy, copyFor, languageName } from './copy'

export type Display = 'both' | 'translated' | 'original'

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

// 色。相手は灯りの琥珀、原文はスレート、警告はレンガ。それ以外は端末の既定色に任せる
const AMBER = '#d7a35f'
const SLATE = '#8a94a6'
const BRICK = '#d75f5f'

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

function Fuse(kit: Kit, view: View, now: number, columns: number, copy: Copy) {
  const { Box, Text } = kit
  if (view.deadline === null || view.span === null) return null
  const remaining = Math.max(0, view.deadline - now)
  const seconds = copy.seconds(Math.ceil(remaining / 1000))
  const { lit, tip, burnt } = fuse(remaining, view.span, columns - seconds.length - 1)
  return (
    <Box key="fuse">
      <Text color={AMBER}>{lit}</Text>
      <Text color={BRICK}>{tip}</Text>
      <Text dimColor>{burnt} </Text>
      <Text bold={view.phase === 'final'}>{seconds}</Text>
    </Box>
  )
}

function LineView(kit: Kit, line: Line, view: View, copy: Copy, display: Display, actions: Actions) {
  const { Box, Text, Button } = kit
  if (line.from === 'me') {
    return (
      <Box key={line.id} flexDirection="column" marginTop={1}>
        <Text dimColor>
          {copy.you}
          {line.isFinal ? ` · ${copy.lastWord}` : ''}
        </Text>
        <Text>{line.text}</Text>
      </Box>
    )
  }

  const label = (
    <Text color={AMBER} bold>
      {copy.someone}
      {line.isFinal ? <Text color={AMBER}> · {copy.lastWord}</Text> : null}
    </Text>
  )
  if (line.text === null) {
    return (
      <Box key={line.id} flexDirection="column" marginTop={1}>
        {label}
        <Text dimColor>{copy.skippedLastWord}</Text>
      </Box>
    )
  }
  if (line.flagged && !line.revealed) {
    return (
      <Box key={line.id} flexDirection="column" marginTop={1}>
        {label}
        <Box>
          <Text dimColor>{copy.hidden} </Text>
          <Button key={`reveal-${line.id}`} label={copy.show} plain onPress={() => actions.reveal(line.id)} />
        </Box>
      </Box>
    )
  }

  // 翻訳文を大きく(既定色)、原文を小さく(スレート)。翻訳が無ければ原文を主にする
  const main =
    display === 'original' || line.translation === 'none' || line.translated === null ? line.text : line.translated
  const showOriginal =
    display === 'both' && main !== line.text
  const status =
    line.translation === 'pending' ? copy.translating : line.translation === 'failed' ? copy.translateFailed : null
  return (
    <Box key={line.id} flexDirection="column" marginTop={1}>
      {label}
      <Text>{main}</Text>
      {showOriginal ? <Text color={SLATE}>{line.text}</Text> : null}
      {status ? <Text dimColor italic>{status}</Text> : null}
      {line.warnings.includes('command') ? <Text color={BRICK}>{copy.commandWarning}</Text> : null}
      {line.warnings.includes('url') ? <Text color={BRICK}>{copy.urlWarning}</Text> : null}
    </Box>
  )
}

function Composer(kit: Kit, view: View, copy: Copy, actions: Actions) {
  const { Box, Text, Button, Input } = kit
  const isFinal = view.phase === 'final'
  return (
    <Box key="composer" flexDirection="column" marginTop={1}>
      {view.draftWarning ? <Text color={BRICK}>{copy.draft[view.draftWarning]}</Text> : null}
      {Input ? (
        <Input
          key={`say-${view.inputGen}`}
          placeholder={isFinal ? copy.finalPlaceholder : copy.placeholder}
          value={view.draft}
          submitLabel={copy.send}
          autoFocus
          onSubmit={text => (isFinal ? actions.sayLast(text) : actions.say(text))}
        />
      ) : (
        <Text dimColor>{copy.noInputHere}</Text>
      )}
      <Box gap={1} marginTop={1}>
        {isFinal ? <Button key="skip" label={copy.skip} variant="primary" onPress={() => actions.sayLast(null)} /> : null}
        {isFinal ? null : <Button key="leave" label={copy.leave} onPress={actions.leave} />}
        <Button key="block" label={copy.block} onPress={actions.block} />
        <Button key="report" label={copy.report} onPress={actions.report} />
      </Box>
    </Box>
  )
}

export type PaneInput = {
  kit: Kit
  view: View
  now: number
  columns: number
  rows: number
  display: Display
  matchDelaySeconds: number
  actions: Actions
}

export function drawPane({ kit, view, now, columns, rows, display, matchDelaySeconds, actions }: PaneInput) {
  const { Box, Text, Button } = kit
  const copy = copyFor(view.myLang)
  const width = Math.max(20, columns)

  const header = (
    <Box key="header" flexDirection="column">
      <Text bold>meanwhile</Text>
      <Text dimColor>{copy.shareNote}</Text>
    </Box>
  )
  const banner = view.needsYou ? (
    <Box key="needs-you" marginTop={1}>
      <Text inverse color={AMBER}> ! {copy.needsYou} </Text>
    </Box>
  ) : null
  const notice = view.notice ? (
    <Box key="notice" marginTop={1}>
      <Text italic dimColor>{copy.notices[view.notice]}</Text>
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
        <Box key="consent" flexDirection="column" marginTop={1}>
          <Text bold>{copy.consentTitle}</Text>
          {copy.consentPoints.map((point, i) => (
            <Box key={`point-${i}`}>
              <Text color={AMBER}>· </Text>
              <Text>{point}</Text>
            </Box>
          ))}
          <Box gap={1} marginTop={1}>
            <Button key="agree" label={copy.agree} variant="primary" autoFocus onPress={actions.agree} />
            <Button key="cancel" label={copy.cancel} onPress={actions.cancelConsent} />
          </Box>
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
      const farewell = view.lines.map(line => LineView(kit, line, view, copy, display, actions))
      const canReport = view.lines.some(line => line.from === 'peer')
      body = (
        <Box key="waiting" flexDirection="column" marginTop={1}>
          {view.phase === 'working' ? Fuse(kit, view, now, width, copy) : null}
          <Text dimColor={view.phase === 'idle'}>{status}</Text>
          {farewell}
          <Box gap={1} marginTop={1}>
            {view.phase === 'idle' ? (
              <Button key="turn-off" label={copy.turnOff} onPress={actions.disable} />
            ) : (
              <Button key="stop" label={copy.stopSearch} onPress={actions.stopSearch} />
            )}
            {canReport ? <Button key="report-after" label={copy.report} onPress={actions.report} /> : null}
            {canReport ? <Button key="block-after" label={copy.block} onPress={actions.block} /> : null}
          </Box>
        </Box>
      )
      break
    }
    case 'chatting':
    case 'final': {
      // 1通にだいたい3行。入り切る分だけ新しい順に見せる
      const room = Math.max(2, Math.floor((rows - 16) / 3))
      body = (
        <Box key="chat" flexDirection="column" marginTop={1}>
          {view.phase === 'final' ? Fuse(kit, view, now, width, copy) : null}
          {view.phase === 'final' ? (
            <Text bold>{copy.finalPrompt}</Text>
          ) : (
            <Text color={AMBER}>{copy.connected(languageName(view.peerLang ?? 'und', view.myLang))}</Text>
          )}
          {view.lines.slice(-room).map(line => LineView(kit, line, view, copy, display, actions))}
          {Composer(kit, view, copy, actions)}
        </Box>
      )
      break
    }
  }

  return (
    <Box flexDirection="column" width={width}>
      {header}
      {banner}
      {notice}
      {body}
    </Box>
  )
}
