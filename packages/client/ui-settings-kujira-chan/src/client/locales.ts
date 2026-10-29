/** Locale bundles for the Kujira Chan plugin page. */

/** Locale keys the page renders. */
export type KujiraChanLocaleKey =
  | 'title' | 'description' | 'blank'
  | 'add' | 'addPlaceholder' | 'empty' | 'remove' | 'loading' | 'failed'
  | 'workspace' | 'session' | 'listTitle' | 'openSession'
  | 'dropTitle' | 'dropDeleteWorkspace' | 'dropDeleteWorkspaceHint' | 'dropSessions'
  | 'dropKeepSessions' | 'dropArchiveSessions' | 'confirm' | 'cancel'
  | 'configure' | 'promptTitle' | 'promptPlaceholder' | 'promptSummary' | 'promptEmpty' | 'save'
  | 'mainSessionNotice'
  | 'mainSessionStop' | 'mainSessionStopHint'

/** English copy. */
export const en: Record<KujiraChanLocaleKey, string> = {
  mainSessionNotice: 'This is a persona main session. Start conversations from another session in its workspace.',
  mainSessionStop: 'Stop',
  mainSessionStopHint: 'Cancel whatever the main session is doing right now.',
  title: 'Kujira Chan',
  description: 'The Kujira Chan build of this harness.',
  blank: 'Each persona below owns its own workspace and one main session.',
  listTitle: 'Personas',
  add: 'Add persona',
  addPlaceholder: 'Persona name',
  empty: 'No persona yet. Add one to create its workspace and main session.',
  remove: 'Remove',
  loading: 'Loading…',
  failed: 'The operation did not complete. Try again.',
  workspace: 'Workspace',
  session: 'Main session',
  openSession: 'Open main session',
  dropTitle: 'Remove persona',
  dropDeleteWorkspace: 'Also delete the workspace directory',
  dropDeleteWorkspaceHint: 'This unregisters the workspace and deletes its files from disk. It cannot be undone.',
  dropSessions: 'Sessions in the workspace',
  dropKeepSessions: 'Keep them',
  dropArchiveSessions: 'Archive them',
  confirm: 'Remove',
  cancel: 'Cancel',
  configure: 'Configure',
  promptTitle: 'Persona prompt',
  promptPlaceholder: 'Describe who this persona is and how it should answer.',
  promptSummary: 'Prompt',
  promptEmpty: 'not set',
  save: 'Save',
}

/** Simplified Chinese copy. */
export const zh: Record<KujiraChanLocaleKey, string> = {
  mainSessionNotice: '这是人格主会话。请在该工作区的其他会话里发起对话。',
  mainSessionStop: '停止',
  mainSessionStopHint: '立即中止主会话当前正在做的事情。',
  title: 'Kujira Chan',
  description: '本 Harness 的 Kujira Chan 构建版。',
  blank: '下面每个人格都拥有自己的工作区，以及一个主会话。',
  listTitle: '人格列表',
  add: '添加人格',
  addPlaceholder: '人格名称',
  empty: '还没有人格。添加一个就会创建它的工作区和主会话。',
  remove: '移除',
  loading: '加载中…',
  failed: '操作没有完成，请重试。',
  workspace: '工作区',
  session: '主会话',
  openSession: '打开主会话',
  dropTitle: '移除人格',
  dropDeleteWorkspace: '同时删除工作区目录',
  dropDeleteWorkspaceHint: '会注销工作区并把目录从磁盘删除，无法恢复。',
  dropSessions: '工作区内的会话',
  dropKeepSessions: '保留',
  dropArchiveSessions: '归档',
  confirm: '移除',
  cancel: '取消',
  configure: '配置',
  promptTitle: '人格提示词',
  promptPlaceholder: '描述这个人格是谁、应该怎么回答。',
  promptSummary: '提示词',
  promptEmpty: '未设置',
  save: '保存',
}
