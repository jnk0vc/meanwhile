// 自分の言語の判定。macOSのデスクトップアプリはLANGが空のことが多く、端末もシステムが
// 日本語のままLANGをen_USにしていることがあるため、macOSではシステム設定の言語を優先する。

/**
 * `defaults read -g AppleLanguages`の出力から、いちばん上に並んだ言語を取り出す。
 * 出力は `("ja-JP", "en-JP")` の形で、記号を含まない値は引用符なしで並ぶ(`(en, ja)`)。
 */
export function parseAppleLanguages(output: string): string | null {
  const first = /\(\s*"?([A-Za-z]{2,3})(?=[-_",\s)])/.exec(output)
  return first ? first[1]!.toLowerCase() : null
}

/**
 * `ja_JP.UTF-8`・`ja_JP`(AppleLocale)・`en`のような値から言語を取り出す。
 * `C`・`POSIX`・空は言語ではないのでnullにする。
 */
export function parseLocale(raw: string): string | null {
  const match = /^([a-z]{2,3})(?:[_.@-]|$)/.exec(raw.trim())
  return match ? match[1]! : null
}

/**
 * LANGUAGE・LC_ALL・LC_MESSAGES・LANGの値をこの順に並べて渡し、言語を取り出す。
 * gettextが文言の言語を選ぶのと同じ順で、前にあるものほど優先する。LANGUAGEは`ja:en`のような優先順の並びなので先頭から見る。
 * `LC_ALL=C`のように言語でない値は飛ばして次を見る。ロケールとしてはCが効いていても、
 * 本人が読む言語はLANGに残っていることが多いため
 */
export function languageFromEnv(values: readonly (string | undefined)[]): string | null {
  for (const value of values) {
    for (const item of (value ?? '').split(':')) {
      const lang = parseLocale(item)
      if (lang) return lang
    }
  }
  return null
}
