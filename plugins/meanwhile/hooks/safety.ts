// 受信側の守りと、送信前の確認。相手はModを使わない自作クライアントかもしれないので、
// 受け取った文はすべてここを通してから表示する。

import type { DraftWarning, Warning } from '../types'

export const MAX_TEXT = 200

// ESC / CSI / OSCなどのエスケープ列(ANSI)
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]|\u009b[0-?]*[ -/]*[@-~]/g
// 改行以外の制御文字(C0 / DEL / C1)
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g
// ゼロ幅文字・文字の向きを変える制御文字・異体字セレクタ以外の不可視の書式文字
const INVISIBLE = /[­؜ᅟᅠ᠎​-‏‪-‮⁠-⁯ㅤ﻿￹-￻]/g

/**
 * 表示してよい純粋なテキストにする。エスケープ列・制御文字・不可視の書式文字を除き、
 * 連続する改行は1つにまとめ、長さを上限で切る。
 */
export function sanitize(text: string, max = MAX_TEXT): string {
  const cleaned = text
    .replace(ANSI, '')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return [...cleaned].slice(0, max).join('')
}

const URL_LIKE = /\b(?:https?|ftp|file|ssh|git):\/\/[^\s]+|\bwww\.[^\s]+\.[a-z]{2,}[^\s]*/gi

/**
 * URLをリンクとして扱われない形にする。端末の自動リンク検出にも拾われないよう、
 * 「://」と最初のドットを崩す(https://evil.example → https[:]//evil[.]example)。
 */
export function defangUrls(text: string): string {
  return text.replace(URL_LIKE, url =>
    url.replace('://', '[:]//').replace(/^(\S*?[^[])\.(?!\])/, '$1[.]'),
  )
}

const COMMAND_PATTERNS: readonly RegExp[] = [
  /\b(?:curl|wget|iwr|irm)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
  /\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
  /\b(?:bash|sh|zsh)\s+-c\b/i,
  /\bsudo\s+\S/i,
  /\brm\s+-[a-z]*[rf]/i,
  /\bchmod\s+[+0-7]/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|exec|dlx|x)\b/i,
  /\bnpx\s+\S/i,
  /\bpip3?\s+install\b/i,
  /\bbrew\s+install\b/i,
  /\b(?:apt|apt-get|yum|dnf)\s+install\b/i,
  /\bgo\s+install\b/i,
  /\bcargo\s+install\b/i,
  /\bgit\s+clone\b/i,
  /\b(?:powershell|pwsh)\b|\biex\b|Invoke-Expression/i,
  /\beval\s*\(|\$\([^)]*\)|`[^`]*\b(?:curl|wget|sh|bash|rm)\b[^`]*`/i,
  /\b(?:base64|openssl)\s+(?:-d|--decode|enc)\b/i,
  /\bclaude\s+(?:-p|--dangerously|mcp\s+add)\b/i,
  /\/dev\/tcp\/|\bnc\s+-e\b|\bmkfifo\b/i,
]

// 長いBase64の塊(難読化したコマンドや鍵の受け渡しに使われやすい)
const BASE64_BLOB = /[A-Za-z0-9+/]{40,}={0,2}/

export function detectWarnings(text: string): Warning[] {
  const warnings: Warning[] = []
  if (COMMAND_PATTERNS.some(p => p.test(text)) || BASE64_BLOB.test(text)) warnings.push('command')
  URL_LIKE.lastIndex = 0
  if (URL_LIKE.test(text)) warnings.push('url')
  URL_LIKE.lastIndex = 0
  return warnings
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\b(?:rk|sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
  /\b[0-9a-f]{40,}\b/i,
]

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

/** 送信してよいか。APIキー・トークン・メールアドレスらしき文字列があれば理由を返して止める */
export function checkOutgoing(text: string): DraftWarning | null {
  if ([...text].length > MAX_TEXT) return 'too-long'
  if (SECRET_PATTERNS.some(p => p.test(text))) return 'secret'
  if (EMAIL.test(text)) return 'email'
  return null
}

// 同じ言語どうしでHaikuを呼ばないときの、手元だけの最低限のNGワード。
// 罵倒・脅し・性的な誘い・詐欺の定番句に絞った出発点で、完全なモデレーションではない。
const NG_WORDS: readonly RegExp[] = [
  /\bf+u+c+k+(?:ing|er)?\b/i,
  /\bc+u+n+t+\b/i,
  /\bkill\s+(?:your|ur)self\b|\bkys\b/i,
  /\b(?:nudes?|send\s+pics|sexting)\b/i,
  /\b(?:seed\s+phrase|private\s+key|wallet\s+address|gift\s*cards?)\b/i,
  /\b(?:telegram|whatsapp)\s*(?:me|@)/i,
  /死ね|しね(?:よ|や|!|！)|殺す|ころす|消えろ|きもい|ガイジ/,
  /エロ|セックス|裸の?写真|パパ活/,
  /秘密鍵|シードフレーズ|ギフトカード|振り込/,
]

export function hasNgWord(text: string): boolean {
  return NG_WORDS.some(p => p.test(text))
}
