import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import { vn } from './api.ts'

/**
 * Reads a note inside the window. The HTML comes from our own notes, and the
 * page's CSP allows no scripts, so the rendered markup is inserted as-is —
 * innerHTML never executes <script>, and inline handlers are blocked.
 */
export function NoteReader({ path, title, onClose }: { path: string; title: string; onClose: () => void }) {
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setMarkdown(null)
    setError(null)
    vn.readNote(path)
      .then(text => { if (!cancelled) setMarkdown(text) })
      .catch(e => { if (!cancelled) setError(String((e as Error).message ?? e)) })
    return () => { cancelled = true }
  }, [path])

  const html = useMemo(() => (markdown ? marked.parse(markdown, { async: false }) : ''), [markdown])
  return (
    <div className="app">
      <header className="titlebar">
        <button onClick={onClose}>← 返回</button>
        <div className="brand reader-title">{title}</div>
        <div className="grow" />
        <button onClick={() => void vn.openNoteAsHtml(title, html)} disabled={!markdown}>用浏览器打开</button>
        <button onClick={() => void vn.openPath(path)}>用默认应用打开</button>
      </header>
      <main className="reader">
        {error && <p className="problem">读取失败：{error}</p>}
        {!markdown && !error && <p className="hint">载入中…</p>}
        {markdown && <article className="note-body" dangerouslySetInnerHTML={{ __html: html }} />}
      </main>
    </div>
  )
}
