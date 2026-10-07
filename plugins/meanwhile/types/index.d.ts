// Meanwhileの$.stateの型。会話ログはこのセッションのメモリにだけ置き、$.store(ディスク)にもトランスクリプトにも書かない。

/** 待機 → 作業中 → マッチ待ち(→ 接続中)→ チャット中 → 最後の一言 */
export type Phase = 'off' | 'consent' | 'idle' | 'working' | 'queued' | 'connecting' | 'chatting' | 'final'

/** 受信文に付ける警告。コマンドらしい文とURL */
export type Warning = 'command' | 'url'

/** 状態の変わり目に一度だけ出す知らせ。文言は表示側で言語ごとに引く */
export type Notice =
  | 'peer-done'
  | 'peer-blocked'
  | 'peer-lost'
  | 'connect-failed'
  | 'you-left'
  | 'blocked'
  | 'reported'
  | 'banned'
  | 'rate-limited'
  | 'server-error'
  | 'no-server'
  | 'no-node'

/** 送信前に止めた理由 */
export type DraftWarning = 'secret' | 'email' | 'too-long'

export type Line = {
  id: string
  from: 'me' | 'peer'
  /** 原文(受信側で無害化済み)。スキップされた最後の一言はnull */
  text: string | null
  /** 受信側のHaikuによる翻訳。同じ言語どうしでは付かない */
  translated: string | null
  translation: 'none' | 'pending' | 'done' | 'failed'
  flagged: boolean
  revealed: boolean
  warnings: Warning[]
  isFinal: boolean
  at: number
}

export type View = {
  phase: Phase
  /** Claudeが作業中か(プロンプト送信〜ターン終了) */
  isWorking: boolean
  /** 手動で退室したあと、次のプロンプトまで相手を探さない */
  isPaused: boolean
  myLang: string
  peerLang: string | null
  lines: Line[]
  /** マッチ開始、または最後の一言の締め切り(ミリ秒) */
  deadline: number | null
  /** deadlineまでの全長。導火線の長さの基準 */
  span: number | null
  /** Claudeが許可や回答を待っている */
  needsYou: boolean
  /** 状態の変わり目に一度だけ出す知らせ */
  notice: Notice | null
}

declare module 'claude-code' {
  interface PluginState {
    meanwhile: {
      view: View
      tick: number
    }
  }
}
