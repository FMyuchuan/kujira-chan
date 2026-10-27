/**
 * The Kujira Chan page, browser half: one entry in the Plugins page's official
 * `plugins.item` list, whose card shows a one-liner and whose page is empty for
 * now. The page renders both views from the owner props alone, so it needs no
 * Host service and no settings namespace of its own.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { KujiraChanPage } from './KujiraChanPage.tsx'
import { en, zh, type KujiraChanLocaleKey } from './locales.ts'

export type { KujiraChanPageProps } from './KujiraChanPage.tsx'
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
export const inject = ['slots', 'locale']

/**
 * Mount the Kujira Chan card on the Plugins page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'ui-settings-kujira-chan: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'kujira-chan', order: 100, label: () => t('title'), locale: NS,
  }, KujiraChanPage)), 'ui-settings-kujira-chan: page')
}
