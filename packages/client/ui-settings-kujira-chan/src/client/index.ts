/**
 * The Kujira Chan page, browser half: one entry in the Plugins page's official
 * `plugins.item` list. The card shows a one-liner; the page maintains the
 * persona list through the Host's `kujiraPersona` Remote, which creates each
 * persona's workspace and main session.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the uiWorkspace service merge used to open the persona's main session.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the generated kujiraPersona Remote namespace.
import type {} from '@deepseek-ai/dsh-host-kujira-chan/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { KujiraChanPage, type KujiraChanFace } from './KujiraChanPage.tsx'
import { MainSessionNotice } from './MainSessionNotice.tsx'
import { en, zh, type KujiraChanLocaleKey } from './locales.ts'

export type { KujiraChanFace, KujiraChanPageProps, KujiraDropOptions } from './KujiraChanPage.tsx'

/** Props of the main-session composer takeover. */
export interface MainSessionNoticeProps {
  /** Selector payload naming the main session in view. */
  matched: { readonly notice: true, readonly sessionId: string }
  /** Locale lookup bound to this plugin's namespace. */
  t: (key: KujiraChanLocaleKey) => string
  /** Cancel whatever the main session is currently doing. */
  stop: (sessionId: string) => void
}
export type { KujiraChanLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Kujira Chan plugin page copy. */
    'settings.kujiraChan': KujiraChanLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.kujiraChan'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.kujiraPersona', 'remote.session', 'uiWorkspace']

/**
 * Mount the Kujira Chan card on the Plugins page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Main sessions refuse direct input. The set is refreshed whenever the page
  // changes personas, and once at startup to cover existing ones.
  const mainSessions = new Set<string>()
  const refreshMainSessions = (): void => {
    void ctx.remote.kujiraPersona.list().then((result) => {
      if (!result.ok) return
      mainSessions.clear()
      for (const item of result.value.items) {
        if (item.sessionId !== undefined) mainSessions.add(String(item.sessionId))
      }
    }).catch(() => undefined)
  }
  refreshMainSessions()
  ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 10,
    select: ({ sessionId }: ComposerChainProps) => sessionId !== undefined && mainSessions.has(String(sessionId))
      ? { notice: true as const, sessionId: String(sessionId) }
      : null,
    locale: NS,
    inject: () => ({
      stop: (sessionId: string) => {
        void ctx.remote.session.cancel({ sessionId: sessionId as never } as never).catch(() => undefined)
      },
    }),
  }, MainSessionNotice)), 'ui-settings-kujira-chan: main session composer')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'ui-settings-kujira-chan: dictionaries')
  const t = ctx.locale.bind(NS)
  const face: KujiraChanFace = {
    list: async () => {
      const result = await ctx.remote.kujiraPersona.list()
      if (!result.ok) {
        console.error('[kujira-chan] list rejected', result.error)
        throw new Error('kujira persona list failed')
      }
      return result.value.items
    },
    create: async (name) => {
      const result = await ctx.remote.kujiraPersona.create({ name })
      if (!result.ok) {
        console.error('[kujira-chan] create rejected', result.error)
        throw new Error('kujira persona create failed')
      }
      refreshMainSessions()
    },
    update: async (id, prompt) => {
      const result = await ctx.remote.kujiraPersona.update({ id, prompt })
      if (!result.ok) {
        console.error('[kujira-chan] update rejected', result.error)
        throw new Error('kujira persona update failed')
      }
    },
    drop: async (id, options) => {
      const result = await ctx.remote.kujiraPersona.drop({
        id,
        deleteWorkspace: options.deleteWorkspace,
        archiveSession: options.archiveSession,
      })
      refreshMainSessions()
      if (!result.ok) {
        console.error('[kujira-chan] drop rejected', result.error)
        throw new Error('kujira persona drop failed')
      }
    },
    openSession: (sessionId) => {
      ctx.uiWorkspace.openSession(sessionId as Parameters<typeof ctx.uiWorkspace.openSession>[0])
    },
  }
  ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'kujira-chan', order: 100, label: () => t('title'), locale: NS, inject: () => face,
  }, KujiraChanPage)), 'ui-settings-kujira-chan: page')
}
