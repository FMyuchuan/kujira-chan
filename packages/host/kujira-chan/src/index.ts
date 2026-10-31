/**
 * Persona main-session orchestration: sibling sessions in one persona workspace
 * forward their user messages to the persona's main session, which answers and
 * delivers the message back through the `kujira_send` tool.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AssembleContext, PromptPresentation } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {
  KujiraWakeup,
  PersonaWakeupListValue,
  KujiraPersona,
  PersonaCreateRequest,
  PersonaCreateValue,
  PersonaListValue,
  PersonaDropRequest,
  PersonaDropValue,
  PersonaUpdateRequest,
  PersonaUpdateValue,
} from './types.ts'

export type * from './types.ts'

/** Store file holding the maintained list under the Harness home. */
const STORE_FILE = 'kujira-personas.json'

/** Directory segment one persona's workspace hangs under. */
const PERSONA_ROOT = join('Documents', 'deepseek-harness', 'personas')

/** The persona slot `dsh-persona` shadows too; naming it is what replaces rather than duplicates. */
const PERSONA_SECTION = 'deployment:persona-prefix'

/** Hard cap on siblings waiting behind one persona. */
const FORWARD_QUEUE_LIMIT = 50

/** Marks a reply the channel must send without quoting the trigger message. */
const NO_QUOTE_MARK = '\u200b'

/** Tool the main session calls to answer a sibling session. */
const SEND_TOOL = 'kujira_send'

/** Standing rules every persona main session receives in its system prompt. */
const MAIN_SESSION_CONTRACT = [
  '【Kujira Chan 主从会话约定 · 系统指令】',
  '你是本工作区的主会话，是这里唯一负责思考和作答的 agent。',
  '- 你收到的每一条 user 消息都不是真人直接发来的，而是工作区里其他会话转发过来的，正文前标注「[来自子会话 <短id> 的消息]」。',
  '- 真正的人在别的会话里，看不到你在这里的输出。直接回答没有用，只有调用工具才算回复。',
  `- 回复方式：${SEND_TOOL}(session_id="<短id>", message="<你的回复>")。`,
  `- 默认不引用对方原消息；需要引用某一条时，给 ${SEND_TOOL} 带上 quote 参数（写那条消息正文的开头一段），匹配不到会报错。`,
  '- 收到「[来自子会话 <短id> 的停止请求]」时，立即停止当前处理，不要再调用任何工具。',
  '- 你可以用 kujira_persona_prompt 查看或改写自己的人格提示词：不传 prompt 是查看，传 prompt 是改写。',
  '- 需要过一会儿自己再行动时，用 kujira_wake 安排一次唤醒：给 in（如 10m、2h）或 at（ISO 时间），可带 reason 说明到点要做什么。',
  '【约定结束】',
].join('\n')


/** One parked forward-only turn that receives replies as they are produced. */
interface ForwardSink {
  /** Text accumulated so far. */
  buffer: string
  /** Set when the persona main session finished its turn. */
  ended: boolean
  /** Whether anything was emitted. */
  present: boolean
}

/** One queued forward from a sibling session to its persona main session. */
interface ForwardItem {
  /** Stable identity for this delivery. */
  readonly id: string
  /** The sibling session that sent it. */
  readonly childSessionId: string
  /** Merged message text delivered to the main session. */
  text: string
  /** Messages that arrived while this item was being answered. */
  pending: string[]
  /** Turn the main session started to answer this item, when known. */
  turn?: number
  /** Whether the main session already answered this item through the reply tool. */
  replied?: boolean
}

/** Per-persona forwarding state: what waits, and what is being answered. */
interface PersonaQueue {
  readonly waiting: ForwardItem[]
  active?: ForwardItem
}

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
  static inject = [
    'remoteAccess', 'typert', 'workspaceRegistry', 'workspaceController', 'sessionController', 'systemPrompt', 'tools', 'sessions',
  ]

  private readonly storePath: string
  /** Schedule file for self-wakeups that survive a restart. */
  private readonly wakeupPath: string
  /** Serializes read-modify-write cycles so two creations cannot drop each other. */
  private tail: Promise<unknown> = Promise.resolve()
  /** Last read persona list, so the synchronous event observer can match a workspace. */
  private personasCache: readonly KujiraPersona[] = []
  /** Message ids already forwarded, so inbox and transcript events cannot double-send. */
  private readonly seenMessages = new Set<string>()
  /** Pending self-wakeups for this process: id -> timer and what to wake with. */
  private readonly wakeups = new Map<string, { timer: NodeJS.Timeout, at: number, reason: string, personaId: string }>()
  /** Interrupts steered into a main session, keyed by child session, awaiting consumption. */
  private readonly awaitingSteer = new Map<string, { personaId: string, text: string }>()
  /** Turn each persona's main session is currently running, absent when it is idle. */
  private readonly runningTurn = new Map<string, number>()
  /** Replies waiting for their sibling's parked turn to end before they are appended. */
  private readonly pendingReplies = new Map<string, string>()
  /** Short handle to full Session id, so the model never has to repeat a 46-char id. */
  private readonly shortIds = new Map<string, string>()
  /** Pending forwards per persona, processed one at a time. */
  private readonly queues = new Map<string, PersonaQueue>()

  /** @param ctx - Host context carrying the Workspace registry and Session controller. */
  constructor(ctx: Context) {
    super(ctx, 'kujiraPersonaController', { namespace: 'kujiraPersona' })
    this.storePath = join(homedir(), '.dsh', STORE_FILE)
    this.wakeupPath = join(homedir(), '.dsh', 'kujira-wakeups.json')
    // The adapter parks on this map, so it must exist before any turn starts.
    const shared = globalThis as unknown as Record<symbol, unknown>
    const waitersKey = Symbol.for('dsh.kujira.forwardWaiters')
    shared[waitersKey] ??= new Map<string, () => void>()
    this.personasCache = this.readSync()
    this.restoreWakeups()
    // A fresh process owns no parked turns, so every silent marker is stale.
    try {
      writeFileSync(join(homedir(), '.dsh', 'kujira-silent-sessions.json'),
        `${JSON.stringify({ sessions: [] }, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // A failed reset only means stale markers; messages still forward.
    }
    // The adapter asks this instead of a file marker: the decision is live, so no
    // write can lose the race against the session's own model request.
    const sharedSlot = globalThis as unknown as Record<symbol, unknown>
    sharedSlot[Symbol.for('dsh.kujira.isForwardOnly')] = (sessionId: string): boolean => {
      try {
        const session = this.ctx.sessions.get(sessionId as SessionId)
        const cwd = (session?.header as { cwd?: unknown } | undefined)?.cwd
        if (typeof cwd !== 'string' || cwd === '') return false
        const persona = this.personasCache.find(item => item.workspacePath === cwd && item.sessionId !== undefined)
        const result = persona !== undefined && persona.sessionId !== sessionId
        return result
      } catch {
        return false
      }
    }
    ctx.effect(() => ctx.on('system-prompt/assemble', (assembly, context, next) =>
      this.injectPersona(assembly, context, next)), 'kujira-chan: persona prompt')
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      this.observe(session, event)
    }), 'kujira-chan: forward sibling prompts')
    ctx.effect(() => ctx.tools.register(this.replyTool()), 'kujira-chan: reply tool')
    ctx.effect(() => ctx.tools.register(this.personaPromptTool()), 'kujira-chan: persona prompt tool')
    ctx.effect(() => ctx.tools.register(this.wakeTool()), 'kujira-chan: wake tool')
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
   * List self-scheduled wakeups of persona main sessions.
   * @returns every pending wakeup across personas.
   */
  @Remote('wakeups')
  async listWakeups(): Promise<PersonaWakeupListValue> {
    return {
      items: [...this.wakeups.entries()].map(([id, entry]): KujiraWakeup => ({
        id,
        personaId: entry.personaId,
        at: entry.at,
        reason: entry.reason,
      })),
    }
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
      // Seed the main session with one prompt: it tells the agent it owns this
      // persona and how to answer siblings, and it makes the session non-blank so
      // the sidebar lists it instead of hiding an event-less session.
      // Seed the main session as a user prompt: only user/message starts a turn,
      // and this text is what teaches the agent that the "user" it sees is a
      // forwarder, so a real reply has to go through the tool.
      try {
        await this.ctx.sessionController.prompt({
          requestId: randomUUID() as never,
          sessionId: session.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: seedMessage(name) }],
        } as never, AbortSignal.timeout(15_000))
      } catch {
        // A rejected seed must not discard a created persona.
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
      this.personasCache = items
      return { persona }
    })
  }

  /**
   * Replace one persona's maintained prompt.
   * @param request - the persona identity and its new prompt text.
   * @returns the updated persona.
   */
  @Remote('update')
  update(request: PersonaUpdateRequest): Promise<PersonaUpdateValue> {
    return this.exclusive(async () => {
      const items = await this.read()
      const index = items.findIndex(item => item.id === request.id)
      const current = items[index]
      if (current === undefined) throw new Error(`unknown persona ${JSON.stringify(request.id)}`)
      const persona: KujiraPersona = { ...current, prompt: request.prompt }
      const next = [...items]
      next[index] = persona
      await this.write(next)
      this.personasCache = next
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
      const kept = items.filter(item => item.id !== request.id)
      await this.write(kept)
      this.personasCache = kept
      if (request.archiveSession === true) {
        // Archive every Session the workspace holds, not only the main one.
        const workspace = target.workspaceId === undefined
          ? undefined
          : this.ctx.workspaceRegistry.get(target.workspaceId as WorkspaceId)
        const sessionIds = workspace?.sessionIds
          ?? (target.sessionId === undefined ? [] : [target.sessionId as SessionId])
        for (const sessionId of sessionIds) {
          try {
            await this.ctx.workspaceController.archiveSession({ sessionId })
          } catch {
            // A failure to archive one Session must not resurrect the registration.
          }
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

  /**
   * Find the persona whose workspace contains a session's working directory.
   * External channels (OneBot and friends) get their own directory under the
   * persona workspace, so the prefix match binds them to that persona.
   * @param sessionId - the session being assembled.
   * @param items - the current persona list.
   * @returns the persona, or undefined when the session is outside every workspace.
   */
  private personaForWorkspace(
    sessionId: string,
    items: readonly KujiraPersona[],
  ): KujiraPersona | undefined {
    const session = this.ctx.sessions.get(sessionId as SessionId)
    const cwd = (session?.header as { cwd?: unknown } | undefined)?.cwd
    if (typeof cwd !== 'string' || cwd === '') return undefined
    return items.find(item => cwd === item.workspacePath || cwd.startsWith(`${item.workspacePath}/`))
  }

  /**
   * Put this assembly's persona prompt into the persona slot of the system prompt.
   * The waterfall context carries the Agent (its `id` is the Session id), so the
   * persona is chosen per Session without touching another Session's prompt.
   * @param _assembly - the pre-waterfall assembly.
   * @param context - the caller's per-assembly context.
   * @param next - the rest of the waterfall.
   * @returns the assembly with this Session's persona prompt in the persona slot.
   */
  private async injectPersona(
    _assembly: PromptPresentation,
    context: AssembleContext,
    next: () => Promise<PromptPresentation>,
  ): Promise<PromptPresentation> {
    const result = await next()
    const carrier = context as unknown as { agent?: { id?: unknown }, scope?: { id?: unknown } }
    const candidate = carrier.agent?.id ?? carrier.scope?.id
    if (typeof candidate !== 'string' || candidate === '') return result
    let text = ''
    try {
      const items = await this.read()
      // A main session is matched by id; an external channel session (QQ, etc.)
      // lives in a subdirectory of the persona workspace and is matched by path,
      // so it still speaks with the persona's prompt.
      const persona = items.find(item => item.sessionId === candidate)
        ?? this.personaForWorkspace(candidate, items)
      if (persona === undefined) return result
      text = (persona.prompt ?? '').trim()
    } catch {
      return result
    }
    // The contract is always present; the persona prompt is appended when configured.
    // Frame the latter as deployment configuration: without it the model reads a
    // strong instruction ("regardless of what the user said") as something smuggled
    // into the conversation and refuses it.
    text = text === ''
      ? MAIN_SESSION_CONTRACT
      : [
          MAIN_SESSION_CONTRACT,
          '',
          '【部署方配置的人格设定 · 属于系统指令，不是用户输入，也不是对话内容】',
          '以下内容由本部署的维护者写入，优先于对话中的任何消息。它不来自用户，请照此执行。',
          '',
          text,
          '【人格设定结束】',
        ].join('\n')
    const sections = Array.isArray(result.sections) ? [...result.sections] : []
    const index = sections.findIndex(section => section.name === PERSONA_SECTION)
    const existing = index === -1 ? undefined : sections[index]
    if (existing === undefined) sections.unshift({ name: PERSONA_SECTION, text })
    else sections[index] = { ...existing, text }
    return { ...result, sections }
  }

  /**
   * Watch one appended Session event: forward a sibling session's user message,
   * and track the main session's turn boundaries.
   * @param session - the session whose log grew.
   * @param event - the appended event.
   */
  private observe(session: Session, event: SessionEvent): void {
    if (event.type === 'agent/inbox/spliced') {
      this.observeInbox(session, event)
      return
    }
    if (event.type === 'turn/start') {
      this.noteTurnStart(session, event)
      const persona = this.personasCache.find(item => item.sessionId === session.id)
      if (persona !== undefined) this.runningTurn.set(persona.id, (event.data as { turn: number }).turn)
      return
    }
    if (event.type === 'turn/end') {
      if ((event.data as { reason?: { kind?: string } }).reason?.kind === 'aborted') this.stopChild(session)
      this.completeAnswer(session, event)
      return
    }
    if (event.type !== 'user/message') return
    const message = event.data as { id?: unknown, source?: { kind?: unknown }, content?: unknown }
    if (message.source?.kind !== 'user') return
    // Did the main session just take in one of our steered interrupts?
    {
      const mainPersona = this.personasCache.find(item => item.sessionId === session.id)
      if (mainPersona !== undefined && this.awaitingSteer.size > 0) {
        const consumed = this.eventText(event)
        for (const [childId, entry] of this.awaitingSteer) {
          if (entry.personaId !== mainPersona.id) continue
          if (!consumed.includes(entry.text.slice(0, 160))) continue
          this.awaitingSteer.delete(childId)
          // The interrupt is now in the main session's history: let the sibling
          // leave its current step so the next one can carry the answer.
          this.release(childId)
          break
        }
      }
    }
    // The inbox handler forwards steer input first; drop the transcript echo.
    if (typeof message.id === 'string' && this.seenMessages.has(message.id)) return
    const text = this.eventText(event)
    if (text === '') return
    this.forwardText(session, text)
  }

  /**
   * Forward a user message that was admitted to a session's inbox. Steer input
   * arrives here before it becomes a transcript message, which is the only place
   * an interruption of a parked sibling can be observed.
   * @param session - the session whose inbox grew.
   * @param event - the inbox splice event.
   */
  private observeInbox(session: Session, event: SessionEvent): void {
    const data = event.data as {
      inserted?: readonly { id?: unknown, source?: { kind?: unknown }, content?: unknown }[]
    }
    for (const message of data.inserted ?? []) {
      if (message.source?.kind !== 'user') continue
      if (typeof message.id !== 'string') continue
      if (this.seenMessages.has(message.id)) continue
      this.seenMessages.add(message.id)
      const content = message.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter((part): part is { type?: string, text: string } =>
          typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text')
        .map(part => part.text)
        .join('')
        .trim()
      if (text !== '') this.forwardText(session, text)
    }
  }

  /**
   * Route one sibling message into its persona's queue or a running turn.
   * @param session - the sibling session that received the message.
   * @param text - the message text.
   */
  private forwardText(session: Session, text: string): void {
    const sessionId = session.id as string
    const cwd = (session.header as { cwd?: unknown } | undefined)?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    const persona = this.personasCache.find(item => item.workspacePath === cwd && item.sessionId !== undefined)
    if (persona === undefined || persona.sessionId === session.id) return
    // Mark before the sibling's own model request is dispatched: this session
    // only forwards, and its adapter parks instead of calling out.
    this.markSilent(sessionId)
    this.shortIds.set(shortSessionId(sessionId), sessionId)
    const queue = this.stateOf(persona.id)
    const active = queue.active
    const mainBusy = this.runningTurn.has(persona.id)
    if (active?.childSessionId === sessionId && mainBusy) {
      // Interrupt while the main session is still working: steer the new text in
      // so the running turn sees it at its next step and adjusts its answer.
      active.text = `${active.text}\n${text}`
      // Steer the new text into the main session's running turn. Do NOT settle the
      // sibling's current step here: its answer belongs to that step, and ending it
      // early would leave the reply with nowhere to land. The queued message stays
      // in the sibling's inbox so its next step picks it up as its own message.
      this.steer(persona, sessionId, text)
      return
    }
    const waiting = queue.waiting.find(item => item.childSessionId === sessionId)
    if (waiting !== undefined) {
      waiting.text = `${waiting.text}\n${text}`
      return
    }
    if (queue.waiting.length >= FORWARD_QUEUE_LIMIT) {
      // Over capacity: let this sibling go rather than park it indefinitely.
      this.release(sessionId)
      return
    }
    queue.waiting.push({ id: randomUUID(), childSessionId: sessionId, text, pending: [] })
    this.pump(persona)
  }

  /**
   * Steer one sibling message into the main session's running turn.
   * @param persona - the owning persona.
   * @param childSessionId - the sibling that sent it.
   * @param text - the new message text.
   */
  private steer(persona: KujiraPersona, childSessionId: string, text: string): void {
    const main = persona.sessionId
    if (main === undefined) return
    const handle = shortSessionId(childSessionId)
    const body = `[来自子会话 ${handle} · 回复用 ${SEND_TOOL}；不需要时可以不回复]\n${text}`
    this.awaitingSteer.set(childSessionId, { personaId: persona.id, text: body })
    void this.ctx.sessionController.prompt({
      requestId: randomUUID() as never,
      sessionId: main as SessionId,
      mode: 'steer',
      content: [{ type: 'text', text: body }],
    } as never, AbortSignal.timeout(30_000)).catch(() => {
      this.awaitingSteer.delete(childSessionId)
    })
  }

  /**
   * Drop one sibling's pending work because its own turn was cancelled.
   * @param session - the sibling session whose turn aborted.
   */
  private stopChild(session: Session): void {
    const sessionId = session.id as string
    const cwd = (session.header as { cwd?: unknown } | undefined)?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    const persona = this.personasCache.find(item => item.workspacePath === cwd && item.sessionId !== undefined)
    if (persona === undefined || persona.sessionId === sessionId) return
    const queue = this.stateOf(persona.id)
    this.pendingReplies.delete(sessionId)
    // Let the model decide to stop: a steer message reaches the running turn and
    // reads as a human cancellation, which is how a normal session stops too.
    this.steerStop(persona, sessionId)
    if (queue.active?.childSessionId === sessionId) {
      delete queue.active
      // The sibling is no longer waiting, so its parked turn ends here.
      this.release(sessionId)
      this.pump(persona)
      return
    }
    const index = queue.waiting.findIndex(item => item.childSessionId === sessionId)
    if (index !== -1) queue.waiting.splice(index, 1)
  }

  /**
   * Ask the main session to abandon a sibling's request.
   * @param persona - the owning persona.
   * @param childSessionId - the sibling the user stopped.
   */
  private steerStop(persona: KujiraPersona, childSessionId: string): void {
    const main = persona.sessionId
    if (main === undefined) return
    const handle = shortSessionId(childSessionId)
    const body = `[来自子会话 ${handle} 的停止请求]\n`
      + '该会话的用户已经停止等待。如果还在为它处理，请立即停止，不要再调用 '
      + `${SEND_TOOL}，也不要继续这条回复。`
    void this.ctx.sessionController.prompt({
      requestId: randomUUID() as never,
      sessionId: main as SessionId,
      mode: 'steer',
      content: [{ type: 'text', text: body }],
    } as never, AbortSignal.timeout(30_000)).catch(() => undefined)
  }

  /**
   * Record the turn a persona's main session started for the active item.
   * @param session - the session that started a turn.
   * @param event - the turn/start event.
   */
  private noteTurnStart(session: Session, event: SessionEvent): void {
    const persona = this.personasCache.find(item => item.sessionId === session.id)
    if (persona === undefined) return
    const active = this.queues.get(persona.id)?.active
    if (active === undefined || active.turn !== undefined) return
    active.turn = (event.data as { turn: number }).turn
  }

  /**
   * Complete the active item when the main session's own turn ends.
   * @param session - the session whose turn ended.
   * @param event - the turn/end event.
   */
  private completeAnswer(session: Session, event: SessionEvent): void {
    const persona = this.personasCache.find(item => item.sessionId === session.id)
    if (persona === undefined) return
    const queue = this.stateOf(persona.id)
    const active = queue.active
    if (active === undefined) return
    const turn = (event.data as { turn: number }).turn
    // A turn we did not start (a person typing into the main session) must not
    // consume the queued item.
    if (active.turn !== undefined && active.turn !== turn) return
    if (active.pending.length > 0) {
      active.text = [active.text, ...active.pending].join('\n')
      active.pending = []
      delete active.turn
      this.dispatch(persona, active)
      return
    }
    this.finish(persona, active)
  }

  /**
   * Read the text of one user message event.
   * @param event - the appended event.
   * @returns the joined text blocks, or an empty string.
   */
  private eventText(event: SessionEvent): string {
    const content = (event.data as { content?: readonly { type?: string, text?: unknown }[] }).content
    if (!Array.isArray(content)) return ''
    return content
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text as string)
      .join('')
      .trim()
  }

  /**
   * Record one session as forwarding-only for the model adapter.
   * @param sessionId - the sibling session that must not call the provider.
   */
  private markSilent(sessionId: string): void {
    try {
      const path = join(homedir(), '.dsh', 'kujira-silent-sessions.json')
      let sessions: string[] = []
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        const list = (parsed as { sessions?: unknown }).sessions
        if (Array.isArray(list)) sessions = list.filter((entry): entry is string => typeof entry === 'string')
      } catch {
        // No list yet.
      }
      if (sessions.includes(sessionId)) return
      sessions.push(sessionId)
      writeFileSync(path, `${JSON.stringify({ sessions }, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // A failed marker degrades to an extra model call, never to a lost message.
    }
  }

  /**
   * Read or create one persona's forwarding state.
   * @param personaId - the persona identity.
   * @returns its queue.
   */
  private stateOf(personaId: string): PersonaQueue {
    const existing = this.queues.get(personaId)
    if (existing !== undefined) return existing
    const created: PersonaQueue = { waiting: [] }
    this.queues.set(personaId, created)
    return created
  }

  /**
   * Deliver the next queued item to a persona's main session when it is idle.
   * @param persona - the persona whose queue to advance.
   */
  private pump(persona: KujiraPersona): void {
    const queue = this.stateOf(persona.id)
    if (queue.active !== undefined) return
    const item = queue.waiting.shift()
    if (item === undefined) return
    queue.active = item
    this.dispatch(persona, item)
  }

  /**
   * Hand one item to the main session.
   * @param persona - the owning persona.
   * @param item - the item to deliver.
   */
  private dispatch(persona: KujiraPersona, item: ForwardItem): void {
    const main = persona.sessionId
    if (main === undefined) return
    const handle = shortSessionId(item.childSessionId)
    const forwarded = `[来自子会话 ${handle} · 回复用 ${SEND_TOOL}；不需要时可以不回复]\n${item.text}`
    void this.ctx.sessionController.prompt({
      requestId: randomUUID() as never,
      sessionId: main as SessionId,
      mode: 'steer',
      content: [{ type: 'text', text: forwarded }],
    } as never, AbortSignal.timeout(60_000)).catch(() => {
      // A rejected forward must release the queue, not wedge the persona.
      this.finish(persona, item)
    })
  }

  /**
   * Mark one item answered, release its sibling session, and advance the queue.
   * @param persona - the persona that owns the item.
   * @param item - the finished item.
   */
  private finish(persona: KujiraPersona, item: ForwardItem): void {
    const queue = this.stateOf(persona.id)
    if (queue.active === item) delete queue.active
    const merged = this.pendingReplies.get(item.childSessionId)
    this.pendingReplies.delete(item.childSessionId)
    if (this.endParked(item.childSessionId)) {
      // The parked turn already streamed the answer; ending it settles the turn.
    } else if (merged !== undefined) {
      // No turn is parked (an interruption consumed it): append the merged answer
      // so it still reaches the sibling, after the messages it answers.
      const target = this.ctx.sessions.get(item.childSessionId as SessionId)
      if (target !== undefined) this.appendAssistant(target, merged)
    }
    this.pump(persona)
  }

  /**
   * Release one sibling session's parked turn without an answer.
   * @param sessionId - the sibling session to unblock.
   */
  private release(sessionId: string, _reply?: string): void {
    const registry = this.sinkRegistry()
    const sink = registry?.get(sessionId)
    if (sink === undefined) return
    sink.ended = true
  }



  /**
   * Read the shared sink map the adapter parks on.
   * @returns the map, when the adapter has registered one.
   */
  private sinkRegistry(): Map<string, ForwardSink> | undefined {
    return (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for('dsh.kujira.forwardWaiters')
    ] as Map<string, ForwardSink> | undefined
  }

  /**
   * Append text to a parked turn's live output.
   * @param sessionId - the sibling session.
   * @param text - the text to append.
   * @returns whether a parked turn received it.
   */
  private pushToParked(sessionId: string, text: string): boolean {
    const sink = this.sinkRegistry()?.get(sessionId)
    if (sink === undefined) return false
    sink.buffer = sink.buffer === '' ? text : `${sink.buffer}\n\n${text}`
    return true
  }

  /**
   * Settle a parked turn so the adapter finishes and commits the streamed answer.
   * @param sessionId - the sibling session.
   * @returns whether a parked turn was settled.
   */
  private endParked(sessionId: string): boolean {
    const sink = this.sinkRegistry()?.get(sessionId)
    if (sink === undefined) return false
    sink.ended = true
    return true
  }

  /**
   * Read the latest turn/step pair from a session's log.
   * @param session - the session to inspect.
   * @returns the newest turn and step numbers, both zero when none exist yet.
   */
  private latestPosition(session: Session): { turn: number, step: number } {
    let turn = 0
    let step = 0
    for (const event of session.ownEvents()) {
      if (event.type === 'turn/start') turn = (event.data as { turn: number }).turn
      if (event.type === 'step/start') step = (event.data as { step: number }).step
    }
    return { turn, step }
  }

  /**
   * Append one assistant message to a session outside any parked turn.
   * @param target - the session to append to.
   * @param text - the reply text.
   */
  private appendAssistant(target: Session, text: string): void {
    const { turn, step } = this.latestPosition(target)
    const message = createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'kujira-chan', model: 'persona-main' },
    })
    target.append('assistant/message', {
      turn,
      step,
      message,
      stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [0], texts: [text] }],
    }, { surfaceOp: 'append' } as never)
  }

  /**
   * Resolve a short handle (or a full id) back to a live Session id.
   * @param handle - the value the model passed to the tool.
   * @returns the full Session id, or undefined when nothing matches.
   */
  private async resolveSession(handle: string): Promise<SessionId | undefined> {
    const trimmed = handle.trim()
    if (trimmed === '') return undefined
    const mapped = this.shortIds.get(trimmed)
    if (mapped !== undefined) return mapped as SessionId
    if (this.ctx.sessions.get(trimmed as SessionId) !== undefined) return trimmed as SessionId
    let match: string | undefined
    const consider = (id: string): boolean => {
      if (id !== trimmed && !id.startsWith(trimmed)) return true
      if (match !== undefined && match !== id) return false
      match = id
      return true
    }
    for (const [short, full] of this.shortIds) {
      if (short === trimmed || !consider(full)) return undefined
    }
    for (const session of this.ctx.sessions.list()) {
      if (!consider(String(session.id))) return undefined
    }
    if (match !== undefined) return match as SessionId
    // Sessions that are only on disk still answer their short handle: the map above
    // is rebuilt per process, so a wakeup scheduled before a restart would
    // otherwise fail here even though the conversation exists.
    try {
      const value = await this.ctx.sessionController.list({}, AbortSignal.timeout(5_000))
      for (const item of value.items) {
        if (!consider(String(item.sessionId))) return undefined
      }
    } catch {
      // Listing failed: fall through with whatever the live set produced.
    }
    return match as SessionId | undefined
  }

  /**
   * Hand the main session's reply to the sibling's parked turn.
   * @param handle - the short session id the model used.
   * @param text - the reply text.
   */
  private async deliverReply(handle: string, text: string, quote?: string): Promise<void> {
    const sessionId = await this.resolveSession(handle)
    if (sessionId === undefined) {
      throw new Error(`unknown session ${JSON.stringify(handle)}; use the id from the forwarded message`)
    }
    // A session that is only on disk (after a restart, or a wakeup scheduled before
    // one) still has to receive this message, and the record belongs in its log.
    // Bringing it back is how the append below can happen at all.
    const target = await this.resolveTarget(sessionId)
    if (target === undefined) {
      throw new Error(`unknown session ${JSON.stringify(handle)}; use the id from the forwarded message`)
    }
    const key = String(sessionId)
    // Channels carry no tool metadata, so the delivery target rides in a leading
    // zero-width marker: MARK<prefix>MARK<body> quotes the recent message starting
    // with <prefix>, while MARK<body> sends without quoting.
    const quoted = quote === undefined || quote.trim() === ''
      ? `${NO_QUOTE_MARK}${text}`
      : `${NO_QUOTE_MARK}${quote.trim()}${NO_QUOTE_MARK}${text}`
    // Remember that this item has been answered, so a later message from the same
    // sibling queues instead of steering into a turn that is already wrapping up.
    for (const queue of this.queues.values()) {
      if (queue.active?.childSessionId === key) {
        queue.active.replied = true
        break
      }
    }
    // Push straight into the parked turn so the answer streams in as it is
    // produced. Repeated calls append to the same sink, keeping one message.
    if (this.pushToParked(key, quoted)) return
    // No parked turn: this is a proactive message. Record it in the sibling's
    // history first (clean text), then push it out through the channel when the
    // sibling belongs to one. Append does not reach the channel, because the
    // channel only listens to live assistant streams.
    this.appendAssistant(target, text)
    const channel = this.channelService()
    const channelKey = typeof channel?.keyOfSession === 'function' ? channel.keyOfSession(key) : undefined
    if (channelKey === undefined || typeof channel?.sendMarked !== 'function') return
    try {
      await channel.sendMarked(channelKey, quoted)
    } catch (error: unknown) {
      throw new Error(`channel send failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The optional channel service (onebot), when that plugin is installed.
   * @returns the service surface, or undefined.
   */
  private channelService(): {
    keyOfSession?: (sessionId: string) => string | undefined
    sendMarked?: (key: string, text: string) => Promise<void>
  } | undefined {
    try {
      return (this.ctx as unknown as { get?: (name: string) => unknown }).get?.('onebot') as
        | { keyOfSession?: (sessionId: string) => string | undefined, sendMarked?: (key: string, text: string) => Promise<void> }
        | undefined
    } catch {
      return undefined
    }
  }

  /**
   * Build the tool that lets a persona main session schedule a wakeup for itself.
   * @returns the tool definition registered on the tools service.
   */
  private wakeTool() {
    const controller = this
    return defineTool({
      name: 'kujira_wake',
      description: 'Schedule this persona main session to wake itself up at a later time. '
        + 'Pass `in` (such as "10m", "2h", "90s") or `at` (ISO 8601 timestamp). '
        + 'When it fires, the session receives a prompt so it can act on its own.',
      parameters: {
        in: { type: 'string', description: 'Relative delay such as 10m, 2h, 90s.' },
        at: { type: 'string', description: 'Absolute ISO 8601 time, e.g. 2026-10-30T16:00:00+08:00.' },
        reason: { type: 'string', description: 'What to remind yourself about when woken.' },
        cancel: { type: 'string', description: 'Id of a scheduled wakeup to cancel instead of creating one.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            at: { type: 'string', required: true },
            cancelled: { type: 'boolean', required: true },
          },
        },
        render: (_args: { cancel?: string }, value: { id: string, at: string, cancelled: boolean }) => [{
          type: 'text',
          text: value.cancelled ? `已取消唤醒 ${value.id}。` : `已安排在 ${value.at} 唤醒。`,
        }],
      },
      async execute(
        args: { in?: string, at?: string, reason?: string, cancel?: string },
        exec: { agent?: { session?: { id?: unknown } } },
      ) {
        const sessionId = String(exec?.agent?.session?.id ?? '')
        const persona = await controller.personaOfMainSession(sessionId)
        if (persona === undefined) throw new Error('这个会话不是人格主会话，不能设置唤醒')
        if (args.cancel !== undefined) {
          const removed = controller.cancelWakeup(args.cancel)
          if (!removed) throw new Error(`没有等待中的唤醒 ${JSON.stringify(args.cancel)}`)
          return { id: args.cancel, at: '', cancelled: true }
        }
        const delay = parseDelay(args)
        if (delay === undefined) throw new Error('需要给出 in（如 10m）或 at（ISO 时间）')
        const at = Date.now() + delay
        const id = randomUUID()
        controller.scheduleWakeup(id, persona.id, at, args.reason ?? '')
        return { id, at: new Date(at).toISOString(), cancelled: false }
      },
    })
  }

  /**
   * Arm one wakeup timer and record it so a restart can re-arm it.
   * @param id - wakeup identity.
   * @param personaId - persona to wake.
   * @param at - absolute epoch milliseconds.
   * @param reason - wakeup text.
   */
  private scheduleWakeup(id: string, personaId: string, at: number, reason: string): void {
    const delay = Math.max(0, at - Date.now())
    const timer = setTimeout(() => {
      this.wakeups.delete(id)
      void this.persistWakeups()
      const persona = this.personasCache.find(item => item.id === personaId)
      if (persona !== undefined) {
        void this.wake(persona, reason === '' ? '（到点了，这是你自己安排的唤醒。）' : reason)
      }
    }, delay)
    timer.unref?.()
    this.wakeups.set(id, { timer, at, reason, personaId })
    void this.persistWakeups()
    // A restarted process may hold wakeups that came due while it was down.
    if (delay === 0) void Promise.resolve()
  }

  /**
   * Cancel one armed wakeup.
   * @param id - wakeup identity.
   * @returns whether it was pending.
   */
  private cancelWakeup(id: string): boolean {
    const entry = this.wakeups.get(id)
    if (entry === undefined) return false
    clearTimeout(entry.timer)
    this.wakeups.delete(id)
    void this.persistWakeups()
    return true
  }

  /** Write the pending wakeups so a restart can re-arm them. */
  private async persistWakeups(): Promise<void> {
    try {
      await mkdir(join(homedir(), '.dsh'), { recursive: true })
      const items = [...this.wakeups.entries()].map(([id, entry]) => ({
        id, personaId: entry.personaId, at: entry.at, reason: entry.reason,
      }))
      const temporary = `${this.wakeupPath}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify({ items }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.wakeupPath)
    } catch {
      // A lost schedule file only costs the wakeup across a restart.
    }
  }

  /** Re-arm wakeups that were pending before this process started. */
  private restoreWakeups(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.wakeupPath, 'utf8'))
      const items = (parsed as { items?: unknown }).items
      if (!Array.isArray(items)) return
      const now = Date.now()
      for (const raw of items) {
        if (typeof raw !== 'object' || raw === null) continue
        const item = raw as { id?: unknown, personaId?: unknown, at?: unknown, reason?: unknown }
        if (typeof item.id !== 'string' || typeof item.personaId !== 'string' || typeof item.at !== 'number') continue
        // Overdue wakeups fire right away so the session still learns about them.
        this.scheduleWakeup(item.id, item.personaId, Math.max(item.at, now), typeof item.reason === 'string' ? item.reason : '')
      }
    } catch {
      // No schedule file yet.
    }
  }

  /**
   * Deliver one self-scheduled wakeup into the persona main session.
   * @param persona - the persona to wake.
   * @param reason - what the wakeup is about.
   */
  private async wake(persona: KujiraPersona, reason: string): Promise<void> {
    const main = persona.sessionId
    if (main === undefined) return
    try {
      await this.ctx.sessionController.prompt({
        requestId: randomUUID() as never,
        sessionId: main as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `[定时唤醒] ${reason}` }],
      } as never, AbortSignal.timeout(30_000))
    } catch {
      // A wakeup that cannot be delivered is dropped; the session keeps running.
    }
  }

  /**
   * Build the tool that lets a persona main session read or rewrite its own
   * persona prompt (the text injected into its system prompt each turn).
   * @returns the tool definition registered on the tools service.
   */
  private personaPromptTool() {
    const controller = this
    return defineTool({
      name: 'kujira_persona_prompt',
      description: 'Read or rewrite this persona\'s system prompt. Omit `prompt` to read the current text; '
        + 'pass it to replace the prompt. Only the persona main session may use this.',
      parameters: {
        prompt: { type: 'string', description: 'New persona prompt. Omit to read the current one.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', required: true },
            updated: { type: 'boolean', required: true },
          },
        },
        render: (_args: { prompt?: string }, value: { prompt: string, updated: boolean }) => [{
          type: 'text',
          text: value.updated ? '人格提示词已更新。' : '当前人格提示词已返回。',
        }],
      },
      async execute(args: { prompt?: string }, exec: { agent?: { session?: { id?: unknown } } }) {
        const sessionId = String(exec?.agent?.session?.id ?? '')
        const persona = await controller.personaOfMainSession(sessionId)
        if (persona === undefined) {
          throw new Error('这个会话不是人格主会话，不能修改人格提示词')
        }
        if (args.prompt === undefined) return { prompt: persona.prompt ?? '', updated: false }
        await controller.savePersonaPrompt(persona.id, args.prompt)
        return { prompt: args.prompt, updated: true }
      },
    })
  }

  /**
   * Resolve the persona this session is the main session of.
   * @param sessionId - the calling session.
   * @returns the persona, or undefined when the session is not a main session.
   */
  private async personaOfMainSession(sessionId: string): Promise<KujiraPersona | undefined> {
    const items = await this.read()
    return items.find(item => item.sessionId === sessionId)
  }

  /**
   * Persist a new prompt for one persona and refresh the synchronous cache the
   * system-prompt waterfall reads.
   * @param id - persona identity.
   * @param prompt - new prompt text (may be empty to clear it).
   */
  private async savePersonaPrompt(id: string, prompt: string): Promise<void> {
    await this.exclusive(async () => {
      const items = await this.read()
      const index = items.findIndex(item => item.id === id)
      const current = items[index]
      if (current === undefined) throw new Error(`unknown persona ${JSON.stringify(id)}`)
      const next = [...items]
      next[index] = { ...current, prompt }
      await this.write(next)
      this.personasCache = next
    })
  }

  /**
   * Get a session from memory, resuming it from disk when it is not loaded.
   * @param sessionId - full session id.
   * @returns the live session, or undefined when it does not exist.
   */
  private async resolveTarget(sessionId: SessionId): Promise<Session | undefined> {
    const loaded = this.ctx.sessions.get(sessionId)
    if (loaded !== undefined) return loaded
    try {
      const result = await this.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in result) return undefined
    } catch {
      return undefined
    }
    return this.ctx.sessions.get(sessionId)
  }

  /**
   * Build the tool the main session uses to answer a sibling session.
   * @returns the tool definition registered on the tools service.
   */
  private replyTool() {
    const controller = this
    return defineTool({
      name: SEND_TOOL,
      description: 'Send a message from this persona main session into a sibling session of the same workspace. '
        + 'Use the short session id a forwarded message named. When that session has no pending turn, the message '
        + 'is also pushed to its channel (QQ) as a proactive message.',
      parameters: {
        session_id: { type: 'string', required: true, description: 'The short session id shown in a forwarded message, such as 6cba11d0.' },
        message: { type: 'string', required: true, description: 'The message text to place in that session.' },
        quote: { type: 'string', description: 'Content prefix of a recent message to quote. Pass it only when the message must point at one specific earlier message; the send fails when nothing matches.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { delivered: { type: 'boolean', required: true } },
        },
        render: (args: { session_id: string }) => [{ type: 'text', text: `reply delivered to ${args.session_id}` }],
      },
      async execute(args: { session_id: string, message: string, quote?: string }) {
        await controller.deliverReply(args.session_id, args.message, args.quote)
        return { delivered: true }
      },
    })
  }

  /** Run one read-modify-write cycle after every earlier one settled. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.catch(() => undefined)
    return run
  }

  /**
   * Read the store synchronously so the event observer always sees the current list.
   * @returns every stored persona, or an empty list.
   */
  private readSync(): readonly KujiraPersona[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.storePath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return []
      const document = parsed as Partial<StoreDocument>
      return Array.isArray(document.items) ? document.items : []
    } catch {
      return []
    }
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
 * Resolve a wakeup delay from either a relative duration or an absolute time.
 * @param args - tool arguments.
 * @returns milliseconds from now, or undefined when neither form parses.
 */
function parseDelay(args: { in?: string, at?: string }): number | undefined {
  if (typeof args.in === 'string' && args.in.trim() !== '') {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/iu.exec(args.in.trim())
    if (match !== null) {
      const amount = Number(match[1])
      const unit = (match[2] ?? 'm').toLowerCase()
      const scale = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
      const delay = amount * scale
      if (Number.isFinite(delay) && delay > 0) return delay
    }
  }
  if (typeof args.at === 'string' && args.at.trim() !== '') {
    const target = Date.parse(args.at.trim())
    if (Number.isFinite(target)) {
      const delay = target - Date.now()
      if (delay > 0) return delay
    }
  }
  return undefined
}

/**
 * Shorten a Session id to the handle the model sees.
 * @param sessionId - the full `session-<uuid>` identity.
 * @returns the first eight uuid characters, or the input when it does not match.
 */
function shortSessionId(sessionId: string): string {
  // External channels may hand out a bare UUID instead of the `session-<uuid>`
  // form, so the handle comes from whichever prefix is present.
  const match = /^(?:session-)?([0-9a-f]{8})/iu.exec(sessionId)
  return match?.[1] ?? sessionId
}

/**
 * Compose the main session's standing instructions.
 * @param name - the persona's display name.
 * @returns the seed prompt text.
 */
function seedMessage(name: string): string {
  // Kept as a user prompt on purpose: only user/message starts a turn, and the
  // session must run one turn to be persisted and listed in the sidebar. The
  // standing rules live in the system prompt instead.
  return `【初始化】「${name}」主会话已就绪。工作区其他会话的消息会转发到这里。`
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
