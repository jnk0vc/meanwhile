// weriftがログに使うdebugパッケージの代わり。ビルド時にesbuildのaliasで差し替える。
// サイドカーはweriftのログを出さないので、何もしないロガーを返す。
// 本物のdebugは名前を組み立てて環境変数(DEBUG_*)を読むため、配布物に入れない。

type Logger = ((...args: unknown[]) => void) & { enabled: boolean; namespace: string; extend: (sub: string) => Logger }

function createDebug(namespace: string): Logger {
  return Object.assign(() => undefined, {
    enabled: false,
    namespace,
    extend: (sub: string) => createDebug(`${namespace}:${sub}`),
  })
}

// weriftは`Debug.debug(...)`の形で呼ぶ
createDebug.debug = createDebug

export default createDebug
