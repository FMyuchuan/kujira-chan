/** Locale bundles for the Kujira Chan plugin page. */

/** Locale keys the page renders. */
export type KujiraChanLocaleKey = 'title' | 'description' | 'blank'

/** English copy. */
export const en: Record<KujiraChanLocaleKey, string> = {
  title: 'Kujira Chan',
  description: 'The Kujira Chan build of this harness.',
  blank: 'This page is intentionally empty. Configuration arrives in a later step.',
}

/** Simplified Chinese copy. */
export const zh: Record<KujiraChanLocaleKey, string> = {
  title: 'Kujira Chan',
  description: '本 Harness 的 Kujira Chan 构建版。',
  blank: '这一页目前是空的，配置项会在后续步骤里补上。',
}
