import type { Env } from './lobby.ts'

export { Lobby } from './lobby.ts'

const ABOUT = `Meanwhile matchmaker

This server only pairs two waiting people and relays their connection info (SDP / ICE).
Chat text never passes through here. Source: https://github.com/jnk0vc/meanwhile
`

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/ws' || pathname === '/report') {
      // 待機列は1本なので、DOは世界で1つ
      return env.LOBBY.getByName('global').fetch(request)
    }
    if (pathname === '/') {
      return new Response(ABOUT, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
