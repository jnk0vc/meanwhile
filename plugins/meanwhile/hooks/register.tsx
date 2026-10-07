import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { View } from '../types'
import {
  type Bridge,
  type Command,
  type Reply,
  SidecarError,
  type SidecarEvent,
  isSupportedNode,
  parseSidecarLine,
  randomHex,
  socketPathFor,
  splitLines,
} from './bridge'
import { copyFor } from './copy'
import { type Effect, type MachineEvent, type Settings, initialView, reduce } from './machine'
import { type Actions, type Display, drawPane } from './pane'
import { checkOutgoing, defangUrls, detectWarnings, hasNgWord, sanitize } from './safety'
import { TRANSLATE_SYSTEM, TRANSLATE_TIMEOUT_MS, buildPrompt, parseTranslation } from './translate'

const PANE = 'meanwhile'
const view = atom({ plugin: 'meanwhile', key: 'view' } as const, initialView('en', false))
const tick = atom({ plugin: 'meanwhile', key: 'tick' } as const, 0)

const STORE_ENABLED = 'enabled'
const STORE_CONSENT = 'consent'
const CONSENT_VERSION = 1

type Options = {
  server?: string
  matchDelay?: string
  finalSeconds?: string
  language?: string
  display?: string
  sound?: string
}

type Config = {
  server: string
  settings: Settings
  display: Display
  sound: boolean
  language: string | undefined
}

// サイドカーとタイマーはモジュールの寿命に結びつく。読み込み直すと両方とも終わり、ここも初期化される
let config: Config = {
  server: '',
  settings: { matchDelayMs: 30_000, finalMs: 60_000 },
  display: 'both',
  sound: false,
  language: undefined,
}
let bridge: Bridge | undefined
let starting: Promise<Bridge> | undefined
let timer: Timer | undefined
let ticker: Timer | undefined
let needsYou = false
let lineSeq = 0

function seconds(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

function configFrom(opts: Options): Config {
  return {
    server: (opts.server ?? '').trim().replace(/\/+$/, ''),
    settings: {
      matchDelayMs: seconds(opts.matchDelay, 30, 15, 120) * 1000,
      finalMs: seconds(opts.finalSeconds, 60, 30, 180) * 1000,
    },
    display: opts.display === 'translated' || opts.display === 'original' ? opts.display : 'both',
    sound: opts.sound === 'on',
    language: opts.language,
  }
}

function nextId(): string {
  lineSeq += 1
  return `l${lineSeq}-${randomHex(3)}`
}

function statusFor(v: View): string | undefined {
  const copy = copyFor(v.myLang)
  switch (v.phase) {
    case 'queued':
    case 'connecting':
      return `meanwhile · ${copy.queued}`
    case 'chatting':
      return `meanwhile · ${copy.someone}`
    case 'final':
      return `meanwhile · ${copy.lastWord}`
    default:
      return undefined
  }
}

/** 自分の言語。設定がautoならOSのロケール(LC_ALL → LANG → Intl)から決める */
async function resolveLanguage($: EngineInterface): Promise<string> {
  const setting = config.language
  if (setting && setting !== 'auto' && /^[a-z]{2,3}$/.test(setting)) return setting
  const raw = (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || ''
  const fromEnv = /^([a-z]{2,3})(?:[_.-]|$)/.exec(raw)?.[1]
  if (fromEnv) return fromEnv
  try {
    const fromIntl = new Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0]
    if (fromIntl && /^[a-z]{2,3}$/.test(fromIntl)) return fromIntl
  } catch {
    // Intlが無い環境
  }
  return 'en'
}

async function isConsented($: EngineInterface): Promise<boolean> {
  const consent = (await $.store.get(STORE_CONSENT)) as { v?: unknown } | undefined
  return consent?.v === CONSENT_VERSION
}

// ---- 状態遷移と副作用 ----

async function dispatch($: EngineInterface, event: MachineEvent): Promise<void> {
  let effects: Effect[] = []
  let after: View | undefined
  await update($, view, current => {
    const [next, produced] = reduce(current, event, config.settings)
    effects = produced
    after = next
    return next
  })
  if (after) $.ui.status(statusFor(after))
  for (const effect of effects) await perform($, effect)
}

async function perform($: EngineInterface, effect: Effect): Promise<void> {
  switch (effect.do) {
    case 'join':
      return join($)
    case 'leave':
      return command($, { cmd: 'leave' })
    case 'send':
      return command($, { cmd: 'send', text: effect.text })
    case 'final':
      return command($, { cmd: 'final', text: effect.text })
    case 'block':
      return command($, { cmd: 'block' })
    case 'report':
      return command($, { cmd: 'report' })
    case 'arm': {
      timer?.cancel()
      ticker?.cancel()
      const kind = effect.timer
      timer = $.clock.after(effect.ms, () => void fireTimer($, kind))
      // 導火線を1秒ごとに縮める(再試行の待ちには導火線を出さない)
      ticker = kind === 'retry' ? undefined : $.clock.every(1_000, () => void advance($))
      return
    }
    case 'disarm':
      timer?.cancel()
      ticker?.cancel()
      timer = undefined
      ticker = undefined
      return
    case 'translate':
      void translateLine($, effect.id, effect.text)
      return
    case 'moderate':
      if (hasNgWord(effect.text)) await dispatch($, { type: 'flag', id: effect.id })
      return
    case 'open-pane':
      return openPane($)
    case 'chime':
      if (config.sound) await $.audio.play({ asset: 'sounds/chime.wav' }).catch(() => undefined)
      return
    case 'save-enabled':
      await $.store.set(STORE_ENABLED, effect.value)
      return
  }
}

async function fireTimer($: EngineInterface, kind: 'match' | 'final' | 'retry'): Promise<void> {
  const event: MachineEvent =
    kind === 'match' ? { type: 'match-delay-passed' } : kind === 'final' ? { type: 'final-timeout' } : { type: 'retry' }
  await dispatch($, event)
}

async function advance($: EngineInterface): Promise<void> {
  await update($, tick, n => n + 1)
}

async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: 'Meanwhile' })
  if (opened.isPlaced) return
  // 端末が狭くて自動では開けないときは、知らせだけ出す
  const { myLang, phase } = await read($, view)
  const copy = copyFor(myLang)
  $.ui.toast(`meanwhile: ${phase === 'final' ? copy.finalPrompt : copy.someone} → /meanwhile`)
}

/**
 * 受信側の翻訳。$.model.completeはツールなし・履歴なしの1回きりの補完で、
 * プロジェクトのCLAUDE.mdも読まない。相手の文はClaude本体の文脈には入らない。
 */
async function translateLine($: EngineInterface, id: string, text: string): Promise<void> {
  const { myLang, peerLang } = await read($, view)
  const result = await $.model
    .complete({
      model: 'haiku',
      system: TRANSLATE_SYSTEM,
      prompt: buildPrompt(text, peerLang ?? 'unknown', myLang),
      maxTokens: 600,
      effort: 'low',
      timeoutMs: TRANSLATE_TIMEOUT_MS,
    })
    .catch(() => null)
  const parsed = result?.isAnswered ? parseTranslation(result.text) : null
  await dispatch(
    $,
    parsed ? { type: 'translated', id, text: parsed.translated, flagged: parsed.flagged } : { type: 'translate-failed', id },
  )
}

// ---- サイドカー ----

/** Node 22以降を探す。デスクトップアプリはPATHが短いことがあるので、ログインシェルにも聞く */
async function findNode($: EngineInterface): Promise<string | null> {
  const candidates: string[] = []
  try {
    const found = await $.process.run(['/bin/sh', '-lc', 'command -v node'], { timeoutMs: 5_000 })
    const path = found.stdout.trim().split('\n').pop()
    if (found.exitCode === 0 && path?.startsWith('/')) candidates.push(path)
  } catch {
    // シェルが使えない環境。よくある場所を試す
  }
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  for (const node of [...new Set(candidates)]) {
    try {
      const { exitCode, stdout } = await $.process.run([node, '--version'], { timeoutMs: 5_000 })
      if (exitCode === 0 && isSupportedNode(stdout)) return node
    } catch {
      // その場所には無い
    }
  }
  return null
}

/** サイドカーを起動し、制御ソケットが開くのを待つ。知らせは終わるまでonSidecarに届く */
async function startSidecar($: EngineInterface): Promise<Bridge> {
  const node = await findNode($)
  if (!node) throw new SidecarError('no-node')
  const ready: Bridge = { socketPath: socketPathFor(await $.env.get('TMPDIR'), randomHex(6)), token: randomHex(32) }
  const stream = $.process.spawn({
    argv: [node, `${$.plugin.root}/sidecar/meanwhile-sidecar.mjs`],
    env: { MEANWHILE_SOCKET: ready.socketPath, MEANWHILE_TOKEN: ready.token, MEANWHILE_SERVER: config.server },
  })

  let markReady: () => void = () => undefined
  let markFailed: (error: Error) => void = () => undefined
  const opened = new Promise<void>((resolve, reject) => {
    markReady = resolve
    markFailed = reject
  })

  void (async () => {
    let rest = ''
    try {
      for await (const piece of stream) {
        if (piece.stream !== 'stdout') continue
        const split = splitLines(rest, piece.text)
        rest = split.rest
        for (const line of split.lines) {
          const event = parseSidecarLine(line)
          if (event?.ev === 'ready') markReady()
          if (event) await onSidecar($, event)
        }
      }
    } catch {
      // 起動できなかった、または途中で落ちた
    }
    markFailed(new SidecarError('no-sidecar'))
    await onSidecar($, { ev: 'exited' })
  })()

  await opened
  return ready
}

async function ensureBridge($: EngineInterface): Promise<Bridge> {
  if (bridge) return bridge
  starting ??= startSidecar($).then(
    ready => {
      bridge = ready
      starting = undefined
      return ready
    },
    error => {
      starting = undefined
      throw error
    },
  )
  return starting
}

async function call($: EngineInterface, target: Bridge, body: Command): Promise<Reply> {
  try {
    const response = await $.http.fetch('http://meanwhile.sock/', {
      method: 'POST',
      socketPath: target.socketPath,
      headers: { 'content-type': 'application/json', 'x-meanwhile-token': target.token },
      body: JSON.stringify(body),
    })
    const reply = JSON.parse(response.text) as Reply
    return typeof reply.ok === 'boolean' ? reply : { ok: false, error: 'bad-reply' }
  } catch {
    return { ok: false, error: 'unreachable' }
  }
}

async function command($: EngineInterface, body: Command): Promise<void> {
  if (bridge) await call($, bridge, body)
}

async function join($: EngineInterface): Promise<void> {
  if (!config.server) return dispatch($, { type: 'trouble', notice: 'no-server', retry: false })
  try {
    const target = await ensureBridge($)
    const { myLang } = await read($, view)
    const reply = await call($, target, { cmd: 'join', lang: myLang })
    if (!reply.ok && reply.error !== 'busy') await dispatch($, { type: 'trouble', notice: 'server-error', retry: true })
  } catch (error) {
    const notice = error instanceof SidecarError && error.code === 'no-node' ? 'no-node' : 'server-error'
    await dispatch($, { type: 'trouble', notice, retry: notice === 'server-error' })
  }
}

/** サイドカーからの知らせを状態遷移の出来事に読み替える。相手の文はここで無害化する */
async function onSidecar($: EngineInterface, event: SidecarEvent): Promise<void> {
  const now = await $.clock.now()
  switch (event.ev) {
    case 'matched':
      return dispatch($, { type: 'matched' })
    case 'connected':
      return dispatch($, { type: 'connected', lang: event.lang })
    case 'connect-failed':
      return dispatch($, { type: 'connect-failed' })
    case 'chat': {
      const clean = sanitize(event.text)
      if (!clean) return
      return dispatch($, { type: 'peer-chat', id: nextId(), text: defangUrls(clean), warnings: detectWarnings(clean), now })
    }
    case 'final': {
      const clean = event.text === null ? null : sanitize(event.text) || null
      const warnings = clean ? detectWarnings(clean) : []
      return dispatch($, { type: 'peer-final', id: nextId(), text: clean ? defangUrls(clean) : null, warnings, now })
    }
    case 'peer-left':
      return dispatch($, { type: 'peer-left', reason: event.reason })
    case 'notice':
      if (event.code === 'banned') return dispatch($, { type: 'trouble', notice: 'banned', retry: false })
      if (event.code === 'rate-limited' || event.code === 'busy') {
        return dispatch($, { type: 'trouble', notice: 'rate-limited', retry: true })
      }
      if (event.code === 'bad-request') return dispatch($, { type: 'trouble', notice: 'server-error', retry: true })
      return
    case 'error':
      return dispatch($, { type: 'trouble', notice: 'server-error', retry: true })
    case 'exited': {
      bridge = undefined
      const { phase } = await read($, view)
      if (phase === 'queued' || phase === 'connecting' || phase === 'chatting' || phase === 'final') {
        await dispatch($, { type: 'trouble', notice: 'server-error', retry: true })
      }
      return
    }
    default:
      return
  }
}

// ---- パネルの操作 ----

async function agree($: EngineInterface): Promise<void> {
  await $.store.set(STORE_CONSENT, { v: CONSENT_VERSION, at: await $.clock.now() })
  await dispatch($, { type: 'enable' })
}

async function say($: EngineInterface, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  const warning = checkOutgoing(trimmed)
  if (warning) return dispatch($, { type: 'draft-refused', text: trimmed, warning })
  return dispatch($, { type: 'my-chat', id: nextId(), text: trimmed, now: await $.clock.now() })
}

async function sayLast($: EngineInterface, text: string | null): Promise<void> {
  const trimmed = text?.trim() || null
  const warning = trimmed ? checkOutgoing(trimmed) : null
  if (trimmed && warning) return dispatch($, { type: 'draft-refused', text: trimmed, warning })
  return dispatch($, { type: 'my-final', text: trimmed })
}

function actionsFor($: EngineInterface): Actions {
  return {
    askConsent: () => void dispatch($, { type: 'ask-consent' }),
    cancelConsent: () => void dispatch($, { type: 'cancel-consent' }),
    agree: () => void agree($),
    disable: () => void dispatch($, { type: 'disable' }),
    stopSearch: () => void dispatch($, { type: 'stop-search' }),
    say: text => void say($, text),
    sayLast: text => void sayLast($, text),
    leave: () => void dispatch($, { type: 'leave' }),
    block: () => void dispatch($, { type: 'block' }),
    report: () => void dispatch($, { type: 'report' }),
    reveal: id => void dispatch($, { type: 'reveal', id }),
  }
}

async function markNeedsYou($: EngineInterface, value: boolean): Promise<void> {
  needsYou = value
  await dispatch($, { type: 'needs-you', value })
}

// ---- イベント ----

export const register: Register = (on, options) => {
  config = configFrom(options as Options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'meanwhile',
      description: 'Claudeの作業中に、待っている誰かと匿名で話すパネルを開く(on / off)',
      argumentHint: '[on|off]',
    })
    const myLang = await resolveLanguage($)
    const enabled = (await $.store.get(STORE_ENABLED)) === true && (await isConsented($))
    // 読み込み直しでサイドカーは終わっているので、会話の状態も最初からにする
    await update($, view, () => initialView(myLang, enabled))
    $.ui.status(undefined)
    return next(e)
  })

  on('command.run', { command: 'meanwhile' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await dispatch($, { type: 'disable' })
      return { text: 'meanwhile: off' }
    }
    if (arg === 'on' && (await isConsented($))) {
      await dispatch($, { type: 'enable' })
    } else if (arg === 'on' || (await read($, view)).phase === 'off') {
      await dispatch($, { type: 'ask-consent' })
    }
    await $.ui.open({ id: PANE, title: 'Meanwhile' })
    return { text: 'meanwhile' }
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    await dispatch($, { type: 'work-start', now: await $.clock.now() })
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // サブエージェントの終わりは、Claude本体の作業の終わりではない
    if (e.agentId === undefined) {
      needsYou = false
      await dispatch($, { type: 'work-end', now: await $.clock.now() })
    }
    return done
  })

  // Claudeが許可や回答を求めたら、パネル上部にバナーを出す(状態は変えない)
  on('classic.PermissionRequest', async ($, e, next) => {
    await markNeedsYou($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') await markNeedsYou($, true)
    const result = await next(e)
    if (needsYou) await markNeedsYou($, false)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, view)
    await read($, tick)
    const kit = $.ui.resolve(e)
    return drawPane({
      // モバイルにはまだ入力欄が無い(表に名前はあっても何も描かれない)
      kit: { Box: kit.Box, Text: kit.Text, Button: kit.Button, Input: e.surface !== 'mobile' && 'Input' in kit ? kit.Input : undefined },
      view: v,
      now: await $.clock.now(),
      columns: e.props.bodyColumns,
      rows: e.viewport?.rows ?? 30,
      display: config.display,
      matchDelaySeconds: config.settings.matchDelayMs / 1000,
      actions: actionsFor($),
    })
  })

  on('session.end', async ($, e, next) => {
    if (bridge) await call($, bridge, { cmd: 'quit' })
    return next(e)
  })
}
