/**
 * Composer takeover for a persona's main session: it accepts no direct input,
 * because everything it answers arrives from sibling sessions through the queue.
 * One control survives: stopping whatever the main session is doing right now.
 */
import type { MainSessionNoticeProps } from './index.ts'

/**
 * Render the notice that replaces the composer in a persona main session.
 * @param props Standard slot props plus this plugin's locale and stop bindings.
 * @returns The main-session composer takeover.
 */
export function MainSessionNotice(props: MainSessionNoticeProps) {
  const sessionId = props.matched.sessionId
  return (
    <div
      className="kujira-main-session-notice"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '10px 14px',
        border: '1px dashed color-mix(in srgb, currentColor 28%, transparent)',
        borderRadius: '12px',
        fontSize: '13px',
        lineHeight: 1.5,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: 0.85 }}>
        <span aria-hidden="true">🐋</span>
        <span>{props.t('mainSessionNotice')}</span>
      </span>
      <button
        type="button"
        onClick={() => props.stop(sessionId)}
        title={props.t('mainSessionStopHint')}
        style={{
          flex: '0 0 auto',
          padding: '6px 12px',
          borderRadius: '8px',
          border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
          background: 'transparent',
          color: 'inherit',
          fontSize: '12px',
          cursor: 'pointer',
        }}
      >
        {props.t('mainSessionStop')}
      </button>
    </div>
  )
}
