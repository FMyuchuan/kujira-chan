/** The Kujira Chan page: the maintained persona list, each owning a workspace and a main session. */

import { useCallback, useEffect, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { KujiraPersona } from '@deepseek-ai/dsh-host-kujira-chan/types'

/** Cleanup choices confirmed in the removal dialog. */
export interface KujiraDropOptions {
  /** Unregister the workspace and delete its directory. */
  readonly deleteWorkspace: boolean
  /** Hide the persona's main session from workspace grouping. */
  readonly archiveSession: boolean
}

/** Host operations the page calls; the browser never touches the persona store itself. */
export interface KujiraChanFace {
  /** Read the maintained list. */
  list: () => Promise<readonly KujiraPersona[]>
  /** Create one persona with its workspace and main session. */
  create: (name: string) => Promise<void>
  /** Replace one persona's maintained prompt. */
  update: (id: string, prompt: string) => Promise<void>
  /** Forget one persona, applying the caller's cleanup choices. */
  drop: (id: string, options: KujiraDropOptions) => Promise<void>
  /** Reveal one session as the main conversation. */
  openSession: (sessionId: string) => void
}

/** Props the renderer binds for the Kujira Chan page. */
export type KujiraChanPageProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.kujiraChan'>
  & InjectFace<KujiraChanFace>

const box: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px',
  border: '1px solid rgba(127,127,127,0.35)', borderRadius: 6,
}

const rowEnd: React.CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' }

/**
 * Render the card's one-liner or the persona list, as the Plugins page asks.
 * @param props - the view asked for, locale copy, and the Host operations.
 * @returns the one-liner, or the persona list with its add form, prompt editor, and removal dialog.
 */
export function KujiraChanPage(props: KujiraChanPageProps) {
  const { t, list, create, update, drop, openSession } = props
  const [items, setItems] = useState<readonly KujiraPersona[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [pending, setPending] = useState<KujiraPersona | undefined>()
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)
  const [archiveSession, setArchiveSession] = useState(true)
  const [editing, setEditing] = useState<string | undefined>()
  const [draft, setDraft] = useState('')

  const refresh = useCallback(async () => {
    try {
      setItems(await list())
      setError(false)
    } catch {
      setError(true)
    }
  }, [list])

  useEffect(() => {
    if (props.view === 'page') void refresh()
  }, [props.view, refresh])

  if (props.view === 'summary') return t('description')

  const submit = async (): Promise<void> => {
    if (name.trim() === '' || busy) return
    setBusy(true)
    try {
      await create(name)
      setName('')
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (persona: KujiraPersona): void => {
    setPending(undefined)
    setEditing(persona.id)
    setDraft(persona.prompt ?? '')
  }

  const savePrompt = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await update(id, draft)
      setEditing(undefined)
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const openDialog = (persona: KujiraPersona): void => {
    setEditing(undefined)
    setPending(persona)
    setDeleteWorkspace(false)
    setArchiveSession(true)
  }

  const confirmDrop = async (): Promise<void> => {
    const target = pending
    if (target === undefined) return
    setBusy(true)
    try {
      await drop(target.id, { deleteWorkspace, archiveSession })
      setPending(undefined)
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, opacity: 0.7 }}>{t('blank')}</p>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={name}
          placeholder={t('addPlaceholder')}
          disabled={busy}
          onChange={(event) => { setName(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
          style={{ flex: 1, padding: '6px 8px' }}
        />
        <button type="button" disabled={busy || name.trim() === ''} onClick={() => { void submit() }}>
          {t('add')}
        </button>
      </div>

      {error && <p style={{ margin: 0, color: '#d33' }}>{t('failed')}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <strong style={{ fontSize: '0.9em', opacity: 0.8 }}>{t('listTitle')}</strong>
        {items.length === 0 && <p style={{ margin: 0, opacity: 0.6 }}>{busy ? t('loading') : t('empty')}</p>}
        {items.map(item => (
          <div key={item.id} style={{ ...box, gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <strong>{item.name}</strong>
                <span style={{ fontSize: '0.8em', opacity: 0.7, wordBreak: 'break-all' }}>
                  {t('workspace')}: {item.workspacePath}
                </span>
                <span style={{ fontSize: '0.8em', opacity: 0.7, wordBreak: 'break-all' }}>
                  {t('session')}: {item.sessionId ?? '—'}
                </span>
                <span style={{ fontSize: '0.8em', opacity: 0.7 }}>
                  {t('promptSummary')}: {item.prompt === undefined || item.prompt === ''
                    ? t('promptEmpty')
                    : `${item.prompt.slice(0, 40)}${item.prompt.length > 40 ? '…' : ''}`}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button type="button" disabled={busy} onClick={() => { startEdit(item) }}>
                  {t('configure')}
                </button>
                <button
                  type="button"
                  disabled={busy || item.sessionId === undefined}
                  onClick={() => { if (item.sessionId !== undefined) openSession(item.sessionId) }}
                >
                  {t('openSession')}
                </button>
                <button type="button" disabled={busy} onClick={() => { openDialog(item) }}>
                  {t('remove')}
                </button>
              </div>
            </div>

            {editing === item.id && (
              <div style={{ ...box, marginTop: 8, background: 'rgba(127,127,127,0.06)' }}>
                <strong>{t('promptTitle')}</strong>
                <textarea
                  rows={6}
                  value={draft}
                  placeholder={t('promptPlaceholder')}
                  disabled={busy}
                  onChange={(event) => { setDraft(event.target.value) }}
                  style={{
                    width: '100%', boxSizing: 'border-box', resize: 'vertical',
                    fontFamily: 'inherit', fontSize: '0.9em', lineHeight: 1.5, padding: 8,
                  }}
                />
                <div style={rowEnd}>
                  <button type="button" disabled={busy} onClick={() => { setEditing(undefined) }}>
                    {t('cancel')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => { void savePrompt(item.id) }}>
                    {t('save')}
                  </button>
                </div>
              </div>
            )}

            {pending?.id === item.id && (
              <div style={{ ...box, marginTop: 8, background: 'rgba(127,127,127,0.06)' }}>
                <strong>{t('dropTitle')}: {item.name}</strong>

                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={deleteWorkspace}
                    onChange={(event) => { setDeleteWorkspace(event.target.checked) }}
                  />
                  <span>
                    {t('dropDeleteWorkspace')}
                    <br />
                    <span style={{ fontSize: '0.8em', opacity: 0.7 }}>{t('dropDeleteWorkspaceHint')}</span>
                  </span>
                </label>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>{t('dropSessions')}</span>
                  <label style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="radio"
                      name={`sessions-${item.id}`}
                      checked={!archiveSession}
                      onChange={() => { setArchiveSession(false) }}
                    />
                    {t('dropKeepSessions')}
                  </label>
                  <label style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="radio"
                      name={`sessions-${item.id}`}
                      checked={archiveSession}
                      onChange={() => { setArchiveSession(true) }}
                    />
                    {t('dropArchiveSessions')}
                  </label>
                </div>

                <div style={rowEnd}>
                  <button type="button" disabled={busy} onClick={() => { setPending(undefined) }}>
                    {t('cancel')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => { void confirmDrop() }}>
                    {t('confirm')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
