// AMBIENT MEMO (issue #494) — the renderer drives the rolling loop (open a stream, feed it for ~60s,
// stop it, open the next, …) over the same `speech` IPC used by voice input; the main process
// (ctx.ambient) keeps the accumulated transcript and, after each settled segment, asks `ctx.llm`
// for a fresh rolling summary. This module is the shared contract.

import type { SpeechLanguage } from './speech.ts'

/** what changed in the rolling session — pushed as `ambient:event` to the renderer */
export interface AmbientEvent {
  channel: 'segment' | 'summary' | 'failed'
  /** cumulative transcript (all settled segments joined, newest last) — set on 'segment' */
  transcript?: string
  /** latest LLM summary — set on 'summary' */
  summary?: string
  /** error message — only on 'failed' */
  error?: string
}

/** the renderer's own in-memory snapshot */
export interface AmbientState {
  running: boolean
  transcript: string
  summary: string
  error?: string
}

export const AMBIENT_INITIAL: AmbientState = { running: false, transcript: '', summary: '' }

/** ambient:start input */
export interface AmbientStartInput {
  /** language hint — same rules as speech (shared/speech.ts speechLanguage). undefined = follow screen language */
  language?: SpeechLanguage
}

/** segment length — the renderer feeds the stream this long before stopping it */
export const AMBIENT_SEGMENT_SECONDS = 60
