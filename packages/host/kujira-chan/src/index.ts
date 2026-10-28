/**
 * Kujira Chan personas: a maintained list where each persona owns a workspace
 * directory, a registered Workspace, and its main Session.
 *
 * Creating a persona is the whole feature: the Host creates the directory,
 * registers the Workspace, and starts one ordinary Session inside it. Removing
 * a persona forgets the registration only — the directory, the Workspace, and
 * the Session all stay, because the operator's files are never this service's
 * to delete.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type {
  KujiraPersona,
  PersonaCreateRequest,
  PersonaCreateValue,
  PersonaListValue,
  PersonaDropRequest,
  PersonaDropValue,
} from './types.ts'

export type * from './types.ts'

/** Store file holding the maintained list under the Harness home. */
const STORE_FILE = 'kujira-personas.json'

/** Directory segment one persona's workspace hangs under. */
const PERSONA_ROOT = join('Documents', 'deepseek-harness', 'personas')

/** Persisted document shape. */
interface StoreDocument {
  readonly version: 1
  readonly items: readonly KujiraPersona[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Maintained Kujira Chan persona list and Remote namespace owner. */
    kujiraPersonaController: KujiraPersonaController
  }
}

/** Host service backing the generated `ctx.remote.kujiraPersona` namespace. */
export class KujiraPersonaController extends TypertRemoteService {
  static inject = ['remoteAccess', 'typert', 'workspaceRegistry', 'workspaceController', 'sessionController']

  private readonly storePath: string
  /** Serializes read-modify-write cycles so two creations cannot drop each other. */
  private tail: Promise<unknown> = Promise.resolve()

  /** @param ctx - Host context carrying the Workspace registry and Session controller. */
  constructor(ctx: Context) {
    super(ctx, 'kujiraPersonaController', { namespace: 'kujiraPersona' })
    this.storePath = join(homedir(), '.dsh', STORE_FILE)
  }

  /**
   * Read the maintained persona list.
   * @returns every registered persona in creation order.
   */
  @Remote('list')
  async list(): Promise<PersonaListValue> {
    return { items: await this.read() }
  }

  /**
   * Create one persona together with its workspace directory, Workspace, and main Session.
   * @param request - the display name.
   * @returns the created persona, including the identities it was given.
   */
  @Remote('create')
  create(request: PersonaCreateRequest): Promise<PersonaCreateValue> {
    return this.exclusive(async () => {
      const name = request.name.trim()
      if (name === '') throw new Error('persona name must not be blank')
      const id = `${slug(name)}-${randomUUID().slice(0, 8)}`
      const workspacePath = join(homedir(), PERSONA_ROOT, id)
      await mkdir(workspacePath, { recursive: true })
      const workspace = await this.ctx.workspaceRegistry.create(workspacePath, name)
      const session = await this.ctx.sessionController.create({ workspaceId: workspace.id })
      // A titled main session is what makes the persona recognizable in the sidebar.
      // Renaming needs the Session resolved, which a just-created Session is; a
      // failure here must not discard a Session that already exists.
      try {
        await this.ctx.sessionController.rename({ sessionId: session.sessionId, title: `${name} · 主会话` })
      } catch {
        // The title is cosmetic; keep the created Session regardless.
      }
      const persona: KujiraPersona = {
        id,
        name,
        workspacePath,
        workspaceId: workspace.id,
        sessionId: session.sessionId,
        createdAt: new Date().toISOString(),
      }
      const items = [...await this.read(), persona]
      await this.write(items)
      return { persona }
    })
  }

  /**
   * Forget one persona registration, optionally removing its Workspace and directory
   * and archiving its main Session.
   * @param request - the persona identity and the caller's cleanup choices.
   * @returns whether an entry was removed.
   */
  @Remote('drop')
  drop(request: PersonaDropRequest): Promise<PersonaDropValue> {
    return this.exclusive(async () => {
      const items = await this.read()
      const target = items.find(item => item.id === request.id)
      if (target === undefined) return { removed: false }
      await this.write(items.filter(item => item.id !== request.id))
      if (request.archiveSession === true && target.sessionId !== undefined) {
        try {
          await this.ctx.workspaceController.archiveSession({ sessionId: target.sessionId as SessionId })
        } catch {
          // A failure to archive must not resurrect the removed registration.
        }
      }
      if (request.deleteWorkspace === true) {
        if (target.workspaceId !== undefined) {
          try {
            await this.ctx.workspaceRegistry.delete(target.workspaceId as WorkspaceId)
          } catch {
            // An unregistered Workspace is already the desired end state.
          }
        }
        try {
          await rm(target.workspacePath, { recursive: true, force: true })
        } catch {
          // Leave the directory alone when the filesystem refuses removal.
        }
      }
      return { removed: true }
    })
  }

  /** Run one read-modify-write cycle after every earlier one settled. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.catch(() => undefined)
    return run
  }

  /** Read the store, treating a missing or unreadable file as an empty list. */
  private async read(): Promise<readonly KujiraPersona[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.storePath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return []
      const document = parsed as Partial<StoreDocument>
      return Array.isArray(document.items) ? document.items : []
    } catch {
      return []
    }
  }

  /** Replace the store atomically enough for one Host process. */
  private async write(items: readonly KujiraPersona[]): Promise<void> {
    const document: StoreDocument = { version: 1, items }
    await mkdir(join(homedir(), '.dsh'), { recursive: true })
    const temporary = `${this.storePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    const { rename } = await import('node:fs/promises')
    await rename(temporary, this.storePath)
  }
}

/**
 * Reduce a display name to a directory-safe segment.
 * @param name - the operator's display name.
 * @returns lowercase ASCII words joined by dashes, or `persona` when nothing survives.
 */
function slug(name: string): string {
  const reduced = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  return reduced === '' ? 'persona' : reduced.slice(0, 40)
}

export default KujiraPersonaController
