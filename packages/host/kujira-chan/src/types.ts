/** Public request and value types of the Kujira Chan persona Remote. */

/** One maintained persona: a named workspace and the main session created inside it. */
export interface KujiraPersona {
  /** Stable identity, derived from the name and never reused after removal. */
  readonly id: string
  /** Display name the operator typed. */
  readonly name: string
  /** Absolute directory registered as this persona's workspace. */
  readonly workspacePath: string
  /** Registered Workspace identity, absent when registration failed. */
  readonly workspaceId?: string
  /** The persona's main Session, absent when creation failed. */
  readonly sessionId?: string
  /** ISO timestamp of registration. */
  readonly createdAt: string
  /** Persona prompt text the operator maintains. */
  readonly prompt?: string
}

/** Complete persona list. */
export interface PersonaListValue {
  readonly items: readonly KujiraPersona[]
}

/** Create one persona, its workspace directory, its Workspace, and its main Session. */
export interface PersonaCreateRequest {
  /** Non-blank display name; also decides the workspace directory segment. */
  readonly name: string
}

/** Result of one creation. */
export interface PersonaCreateValue {
  readonly persona: KujiraPersona
}

/** Remove one persona from the maintained list. */
export interface PersonaDropRequest {
  /** Persona identity. */
  readonly id: string
  /** Also remove the Workspace registration and delete its directory from disk. */
  readonly deleteWorkspace?: boolean
  /** Hide the persona's main Session from Workspace grouping surfaces. */
  readonly archiveSession?: boolean
}

/** Result of one removal. */
export interface PersonaDropValue {
  readonly removed: boolean
}

/** Update one persona's maintained prompt. */
export interface PersonaUpdateRequest {
  /** Persona identity. */
  readonly id: string
  /** New prompt text; an empty string clears it. */
  readonly prompt: string
}

/** Result of one update. */
export interface PersonaUpdateValue {
  readonly persona: KujiraPersona
}

/** One self-scheduled wakeup of a persona main session. */
export interface KujiraWakeup {
  /** Wakeup identity, usable with the kujira_wake cancel argument. */
  readonly id: string
  /** Owning persona. */
  readonly personaId: string
  /** Absolute epoch milliseconds when it fires. */
  readonly at: number
  /** What the session asked to be reminded about. */
  readonly reason: string
}

/** Response of the wakeup listing endpoint. */
export interface PersonaWakeupListValue {
  readonly items: readonly KujiraWakeup[]
}
