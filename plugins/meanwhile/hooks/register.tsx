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
import { parseAppleLanguages, parseLocale } from './locale'
import { type Effect, type MachineEvent, type Settings, initialView, reduce } from './machine'
import { type Actions, type Display, drawBand } from './band'
import { SCENES, isScene, previewView } from './preview'
import { checkOutgoing, defangUrls, detectWarnings, hasNgWord, parseRelay, sanitize } from './safety'
import { TRANSLATE_SYSTEM, TRANSLATE_TIMEOUT_MS, buildPrompt, parseTranslation } from './translate'

const view = atom({ plugin: 'meanwhile', key: 'view' } as const, initialView('en', false))
const tick = atom({ plugin: 'meanwhile', key: 'tick' } as const, 0)

const STORE_ENABLED = 'enabled'
const STORE_CONSENT = 'consent'
// 同意画面の内容を変えたら上げる。2: 本体の入力欄から「>> 」で送れるようにした
const CONSENT_VERSION = 2

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
// プラグインのフォルダにdev.jsonがあるときだけ、開発用プレビュー(ツールとコマンド)を使える
let devMode = false
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

/** ステータス行。エンジンがMod名を前に付けるので、ここには状態だけを書く */
function statusFor(v: View): string | undefined {
  const copy = copyFor(v.myLang)
  switch (v.phase) {
    case 'queued':
    case 'connecting':
      return copy.phaseLabel[v.phase]
    case 'chatting':
      return copy.statusTalking
    case 'final':
      return copy.phaseLabel.final
    default:
      return undefined
  }
}

/**
 * 自分の言語。設定がautoなら、macOSのシステム設定の言語 → LC_ALL → LANG → Intlの順に決める。
 * macOSを先にするのは、デスクトップアプリではLANGが空のことが多いため
 */
async function resolveLanguage($: EngineInterface): Promise<string> {
  const setting = config.language
  if (setting && setting !== 'auto' && /^[a-z]{2,3}$/.test(setting)) return setting
  const fromMac = await macLanguage($)
  if (fromMac) return fromMac
  const fromEnv = parseLocale((await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || '')
  if (fromEnv) return fromEnv
  try {
    const fromIntl = new Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0]
    if (fromIntl && /^[a-z]{2,3}$/.test(fromIntl)) return fromIntl
  } catch {
    // Intlが無い環境
  }
  return 'en'
}

/** macOSのシステム設定で選んだ言語。macOS以外(defaultsが無い)ではnull */
async function macLanguage($: EngineInterface): Promise<string | null> {
  for (const key of ['AppleLanguages', 'AppleLocale'] as const) {
    try {
      const { exitCode, stdout } = await $.process.run(['/usr/bin/defaults', 'read', '-g', key], { timeoutMs: 3_000 })
      if (exitCode !== 0) continue
      const lang = key === 'AppleLanguages' ? parseAppleLanguages(stdout) : parseLocale(stdout)
      if (lang) return lang
    } catch {
      return null
    }
  }
  return null
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
    case 'announce':
      return announce($)
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

/**
 * つながったときと最後の一言のときに知らせる。会話は入力欄の上の帯に出るが、
 * Claudeの出力を読んでいると気づきにくいのでトーストも出す
 */
async function announce($: EngineInterface): Promise<void> {
  const { myLang, phase } = await read($, view)
  const copy = copyFor(myLang)
  $.ui.toast(phase === 'final' ? copy.toastFinal : copy.toastConnected)
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
  await dispatch($, { type: 'enable', now: await $.clock.now() })
}

/** 「返信」: 本体の入力欄の先頭に「>> 」を足す。打ちかけの下書きは残す */
async function reply($: EngineInterface): Promise<void> {
  const { text } = await $.prompt.read()
  if (parseRelay(text) !== null) return
  await $.prompt.fill({ text: `>> ${text}`, mode: 'replace' })
}

function actionsFor($: EngineInterface): Actions {
  return {
    cancelConsent: () => void dispatch($, { type: 'cancel-consent' }),
    agree: () => void agree($),
    stopSearch: () => void dispatch($, { type: 'stop-search' }),
    reply: () => void reply($).catch(() => undefined),
    skip: () => void dispatch($, { type: 'my-final', text: null }),
    leave: () => void dispatch($, { type: 'leave' }),
    block: () => void dispatch($, { type: 'block' }),
    report: () => void dispatch($, { type: 'report' }),
    reveal: id => void dispatch($, { type: 'reveal', id }),
    dismiss: () => void dispatch($, { type: 'dismiss-notice' }),
  }
}

/** 開発用プレビュー: 会話を止め、帯を見本の状態にする */
async function showPreview($: EngineInterface, scene: Parameters<typeof previewView>[0]): Promise<void> {
  const { myLang } = await read($, view)
  const now = await $.clock.now()
  await dispatch($, { type: 'disable' })
  await update($, view, () => previewView(scene, myLang, now))
}

/**
 * 本体の入力欄に「>> 」で始めて打った文を、Claudeには渡さず相手に送る。
 * 人が入力欄に打ったもの(origin: composer)だけが対象で、他のエージェントやタスクから
 * 届いたプロンプトは送らない。Meanwhileがオフなら普通のプロンプトとして通す
 */
async function relay($: EngineInterface, body: string): Promise<{ drop: string } | null> {
  const v = await read($, view)
  if (v.phase === 'off' || v.phase === 'consent') return null
  const copy = copyFor(v.myLang)
  if (v.phase !== 'chatting' && v.phase !== 'final') return { drop: copy.relayNoPeer }
  if (!body) return { drop: copy.relayEmpty }
  const warning = checkOutgoing(body)
  if (warning) return { drop: copy.draft[warning] }
  if (v.phase === 'final') {
    await dispatch($, { type: 'my-final', text: body })
    return { drop: copy.relayFinalSent }
  }
  await dispatch($, { type: 'my-chat', id: nextId(), text: body, now: await $.clock.now() })
  return { drop: copy.relaySent }
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
      description: 'Claudeの作業中に、待っている誰かと匿名で話す(on / off)',
      argumentHint: '[on|off]',
    })
    const myLang = await resolveLanguage($)
    const enabled = (await $.store.get(STORE_ENABLED)) === true && (await isConsented($))
    // 読み込み直しでサイドカーは終わっているので、会話の状態も最初からにする
    await update($, view, () => initialView(myLang, enabled))
    $.ui.status(undefined)
    devMode = await $.fs.exists(`${$.plugin.root}/dev.json`)
    if (devMode) {
      await $.tool.register({
        name: 'preview',
        description: 'Meanwhile開発用: 入力欄の上の帯を見本の状態にして描かせる(サイドカーは使わない)',
        inputSchema: {
          type: 'object',
          properties: { scene: { type: 'string', enum: [...SCENES] } },
          required: ['scene'],
        },
      })
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__meanwhile__preview' }, async ($, e) => {
    // MCPツールの引数はeの直下に並ぶ
    const scene = (e as { scene?: unknown }).scene
    if (!isScene(scene)) return { deny: `scene must be one of: ${SCENES.join(', ')}` }
    await showPreview($, scene)
    return { result: `meanwhile preview: ${scene}` }
  })

  on('command.run', { command: 'meanwhile' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const [verb, scene] = arg.split(/\s+/)
    if (devMode && verb === 'preview') {
      if (!isScene(scene)) return { text: `meanwhile preview <${SCENES.join('|')}>` }
      await showPreview($, scene)
      return { text: `meanwhile preview: ${scene}` }
    }
    const copy = copyFor((await read($, view)).myLang)
    if (arg === 'off') {
      await dispatch($, { type: 'disable' })
      return { text: copy.disabled }
    }
    const { phase } = await read($, view)
    if (phase !== 'off' && phase !== 'consent') return { text: copy.enabled }
    if (await isConsented($)) {
      await dispatch($, { type: 'enable', now: await $.clock.now() })
      return { text: copy.enabled }
    }
    // 同意画面は入力欄の上の帯に出す
    await dispatch($, { type: 'ask-consent' })
    return { text: copy.consentTitle }
  })

  on('prompt.submit', async ($, e, next) => {
    const body = e.origin.kind === 'composer' ? parseRelay(e.text) : null
    if (body === null) return next(e)
    return (await relay($, body)) ?? next(e)
  }).catch(($, e, next) => next(e))

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

  // Claudeが許可や回答を求めたら、帯に一行出す(状態は変えない)
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

  // 会話は別の窓を開かず、本体の入力欄の真上の帯に出す
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await read($, view)
    await read($, tick)
    const kit = $.ui.resolve(e)
    const band = drawBand({
      kit: { Box: kit.Box, Text: kit.Text, Button: kit.Button },
      view: v,
      now: await $.clock.now(),
      columns: e.props.bodyColumns,
      rows: e.props.maxRows,
      display: config.display,
      actions: actionsFor($),
    })
    return band ?? next(e)
  })

  on('session.end', async ($, e, next) => {
    if (bridge) await call($, bridge, { cmd: 'quit' })
    return next(e)
  })
}
