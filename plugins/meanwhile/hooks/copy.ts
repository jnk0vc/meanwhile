// 画面の文言。自分の言語が日本語なら日本語、それ以外は英語で出す。

import type { DraftWarning, Notice, Phase } from '../types'

export type Copy = {
  shareNote: string
  needsYou: string
  consentTitle: string
  consentPoints: readonly string[]
  agree: string
  cancel: string
  working: string
  connectedHint: string
  phaseLabel: Record<Phase, string>
  bandHint: string
  bandFinalHint: string
  toastConnected: string
  toastFinal: string
  statusTalking: string
  relaySent: string
  relayFinalSent: string
  relayNoPeer: string
  relayEmpty: string
  stopSearch: string
  finalPrompt: string
  someone: string
  you: string
  lastWord: string
  skippedLastWord: string
  translating: string
  translateFailed: string
  hidden: string
  show: string
  commandWarning: string
  urlWarning: string
  reply: string
  skip: string
  report: string
  block: string
  leave: string
  dismiss: string
  enabled: string
  disabled: string
  notices: Record<Notice, string>
  draft: Record<DraftWarning, string>
  seconds: (n: number) => string
}

const ja: Copy = {
  shareNote: 'アイディアは匿名の相手に共有されます',
  needsYou: 'Claudeがあなたの回答を待っています',
  consentTitle: '有効にする前に',
  consentPoints: [
    '相手にはあなたのIPアドレスが見えます。直接つなぐためです',
    '書いたことは匿名の相手に届きます。未公開のアイディアを書くかはあなた次第です',
    'プロンプト・コード・ツールの出力は送りません。送るのは、本体の入力欄に「>> 」で始めて打った文だけです',
    '相手の言葉の翻訳には、あなたのClaudeの利用枠(Haiku)を使います',
    '相手の発言はこの帯に出るだけで、Claudeは読みません。退室すると消え、手元にも残りません',
    '18歳以上の方だけが使えます',
  ],
  agree: '同意して有効にする',
  cancel: 'やめる',
  working: 'Claudeが作業中。導火線が尽きたら相手を探します',
  connectedHint: 'Someoneとつながりました。相談したいことを、本体の入力欄に「>> 」で始めて書いてください',
  phaseLabel: {
    off: 'オフ',
    consent: 'オフ',
    idle: '待機中',
    working: 'Claudeが作業中',
    queued: '相手を探しています…',
    connecting: '相手が見つかりました。つないでいます…',
    chatting: '会話中',
    final: '最後の一言',
  },
  bandHint: '本体の入力欄に「>> 」で始めて送ります · アイディアは匿名の相手に共有されます',
  bandFinalHint: '「>> 」で書いた一言を送ると退室します · 時間切れならスキップ扱い',
  toastConnected: 'Someoneとつながりました。「>> 」で話せます',
  toastFinal: 'Claudeの作業が終わりました。「>> 」で最後の一言を送れます',
  statusTalking: 'Someoneと会話中',
  relaySent: 'Someoneに送りました(Claudeには渡していません)',
  relayFinalSent: '最後の一言を送って退室しました(Claudeには渡していません)',
  relayNoPeer: 'Someoneとつながっていないので、送らずに止めました(Claudeにも渡していません)',
  relayEmpty: '「>>」のあとに、Someoneに送る文を書いてください',
  stopSearch: '今回は探さない',
  finalPrompt: 'Claudeの作業が終わりました。最後の一言を1回だけ送れます',
  someone: 'Someone',
  you: 'あなた',
  lastWord: '最後の一言',
  skippedLastWord: '(最後の一言はありませんでした)',
  translating: '翻訳中…',
  translateFailed: '翻訳できませんでした',
  hidden: '不適切かもしれないため伏せています',
  show: '表示する',
  commandWarning: '⚠ コマンドらしき内容。実行しないで',
  urlWarning: '⚠ URLはリンクにしていません',
  reply: '返信',
  skip: 'スキップ',
  report: '通報',
  block: 'ブロック',
  leave: '退室',
  dismiss: '閉じる',
  enabled: 'Meanwhileを有効にしました。プロンプトを送って作業が続けば、相手を探します',
  disabled: 'Meanwhileをオフにしました',
  notices: {
    'peer-done': 'Someoneは作業に戻りました',
    'peer-blocked': 'Someoneが退室しました',
    'peer-lost': 'Someoneとの接続が切れました',
    'connect-failed': 'つながりませんでした。次の相手を探します',
    'you-left': '退室しました。次のプロンプトまで相手を探しません',
    blocked: 'ブロックしました。この相手とは再びつながりません',
    reported: '通報しました。この相手とは再びつながりません',
    banned: '通報が重なったため、しばらく参加できません',
    'rate-limited': '接続が多すぎます。少し待ってから探し直します',
    'server-error': 'マッチングサーバーにつながりません。少し待ってから探し直します',
    'no-server': 'マッチングサーバーが未設定です。/configのmeanwhileのserverに入れてください',
    'no-node': 'Node.js 22以降が見つかりません。インストールしてからもう一度試してください',
  },
  draft: {
    secret: 'APIキーやトークンらしき文字列があるため、送信を止めました',
    email: 'メールアドレスらしき文字列があるため、送信を止めました',
    'too-long': '200文字までです',
  },
  seconds: n => `${n}秒`,
}

const en: Copy = {
  shareNote: 'Your ideas are shared with an anonymous person',
  needsYou: 'Claude is waiting for your answer',
  consentTitle: 'Before you turn this on',
  consentPoints: [
    'The other person can see your IP address, because you connect directly',
    'What you write reaches an anonymous person. Whether to share unreleased ideas is up to you',
    'Your prompts, code, and tool output are never sent. Only what you type in the main prompt starting with ">> " is',
    'Translating their messages uses your own Claude usage (Haiku)',
    'Their messages only appear in this band. Claude never reads them, and they disappear when you leave',
    'You must be 18 or older',
  ],
  agree: 'Agree and turn on',
  cancel: 'Cancel',
  working: 'Claude is working. When the fuse burns out, Meanwhile looks for someone',
  connectedHint: 'You are connected with Someone. Type in the main prompt starting with ">> " to talk',
  phaseLabel: {
    off: 'Off',
    consent: 'Off',
    idle: 'Waiting',
    working: 'Claude is working',
    queued: 'Looking for someone…',
    connecting: 'Found someone. Connecting…',
    chatting: 'Talking',
    final: 'Last word',
  },
  bandHint: 'Send from the main prompt starting with ">> " · Your ideas are shared with an anonymous person',
  bandFinalHint: 'Send one line starting with ">> " to leave · Skipped when time runs out',
  toastConnected: 'Connected with Someone. Talk with ">> "',
  toastFinal: 'Claude is done. Send your last word with ">> "',
  statusTalking: 'Talking with Someone',
  relaySent: 'Sent to Someone (not passed to Claude)',
  relayFinalSent: 'Sent your last word and left (not passed to Claude)',
  relayNoPeer: 'Not sent: you are not connected with anyone (not passed to Claude either)',
  relayEmpty: 'Write your message for Someone after ">>"',
  stopSearch: 'Not this time',
  finalPrompt: 'Claude is done. You can send one last word',
  someone: 'Someone',
  you: 'You',
  lastWord: 'Last word',
  skippedLastWord: '(No last word)',
  translating: 'Translating…',
  translateFailed: 'Could not translate',
  hidden: 'Hidden because it may be inappropriate',
  show: 'Show',
  commandWarning: "⚠ Looks like a command. Don't run it",
  urlWarning: '⚠ URL shown as plain text',
  reply: 'Reply',
  skip: 'Skip',
  report: 'Report',
  block: 'Block',
  leave: 'Leave',
  dismiss: 'Dismiss',
  enabled: 'Meanwhile is on. If Claude keeps working after your prompt, it looks for someone',
  disabled: 'Meanwhile is off',
  notices: {
    'peer-done': 'Someone went back to work',
    'peer-blocked': 'Someone left',
    'peer-lost': 'The connection to Someone dropped',
    'connect-failed': 'Could not connect. Looking for someone else',
    'you-left': 'You left. Meanwhile will not look for anyone until your next prompt',
    blocked: 'Blocked. You will not be matched with them again',
    reported: 'Reported. You will not be matched with them again',
    banned: 'You cannot join for a while because of repeated reports',
    'rate-limited': 'Too many connections. Trying again shortly',
    'server-error': 'Cannot reach the matching server. Trying again shortly',
    'no-server': 'No matching server is set. Set server for meanwhile in /config',
    'no-node': 'Node.js 22 or later was not found. Install it and try again',
  },
  draft: {
    secret: 'Not sent: it contains something that looks like an API key or token',
    email: 'Not sent: it contains something that looks like an email address',
    'too-long': 'Up to 200 characters',
  },
  seconds: n => `${n}s`,
}

export function copyFor(lang: string): Copy {
  return lang.split('-')[0] === 'ja' ? ja : en
}

/** 言語コードを、自分の言語での名前にする(en → 英語) */
export function languageName(code: string, uiLang: string): string {
  try {
    return new Intl.DisplayNames([uiLang], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}
