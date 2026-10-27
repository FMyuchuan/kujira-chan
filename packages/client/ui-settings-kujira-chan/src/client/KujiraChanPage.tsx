/** The Kujira Chan page: a one-liner in the list, an intentionally empty page when opened. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props the renderer binds for the Kujira Chan page. */
export type KujiraChanPageProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.kujiraChan'>

/**
 * Render the card's one-liner or the plugin's page, as the Plugins page asks.
 * @param props - the view asked for and this page's locale copy.
 * @returns the one-liner, or the empty page body.
 */
export function KujiraChanPage(props: KujiraChanPageProps) {
  const { t } = props
  if (props.view === 'summary') return t('description')
  return (
    <p style={{ margin: 0, opacity: 0.7 }}>
      {t('blank')}
    </p>
  )
}
