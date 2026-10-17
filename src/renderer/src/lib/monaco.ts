import type * as MonacoApi from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import htmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'

let pending: Promise<typeof MonacoApi> | null = null

/**
 * Load Monaco on first use. The editor and its bundled language services are a
 * large chunk that the panes never need, so it is imported dynamically rather
 * than at startup, and the promise is cached so opening a second file reuses
 * the same module instance.
 *
 * Monaco asks `MonacoEnvironment.getWorker` for every worker it needs — the
 * base editor worker plus one per rich language — and falls back to its own
 * `new URL(...)` construction only when that is absent. Answering it here with
 * Vite's `?worker` imports is what makes the workers bundle and load correctly
 * (the internal URLs point into `node_modules` and would not survive the
 * build). It must be installed before the first editor is created, which is why
 * it is set as part of resolving the import.
 */
export function loadMonaco(): Promise<typeof MonacoApi> {
  if (pending) return pending

  pending = import('monaco-editor').then((monaco) => {
    const environment = {
      getWorker(_moduleId: string, label: string): Worker {
        switch (label) {
          case 'json':
            return new jsonWorker()
          case 'css':
          case 'scss':
          case 'less':
            return new cssWorker()
          case 'html':
          case 'handlebars':
          case 'razor':
            return new htmlWorker()
          case 'typescript':
          case 'javascript':
            return new tsWorker()
          default:
            return new editorWorker()
        }
      }
    }
    ;(self as unknown as { MonacoEnvironment: typeof environment }).MonacoEnvironment = environment
    return monaco
  })

  return pending
}

/**
 * Best-effort language id for a filename, matching the `filenames` and
 * `extensions` the registered languages declare. Monaco would not guess on its
 * own when the language is left unspecified, and a wrong id would colour the
 * file with the wrong tokenizer, so an unrecognized name falls back to
 * plaintext.
 */
export function languageFor(monaco: typeof MonacoApi, target: string): string {
  const name = (target.split(/[\\/]/).pop() ?? '').toLowerCase()
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''

  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some((candidate) => candidate.toLowerCase() === name)) {
      return language.id
    }
    if (extension && language.extensions?.some((candidate) => candidate.toLowerCase() === extension)) {
      return language.id
    }
  }

  return 'plaintext'
}
