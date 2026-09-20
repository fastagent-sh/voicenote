import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import { vn, type Job } from './api.ts'
import { friendlyTime, spokenDuration } from './format.ts'

type Props =
  | { job: Job; pending: boolean; onRegenerate: () => void; path?: undefined; title?: undefined; onToast: (message: string) => void }
  | { job?: undefined; pending?: undefined; onRegenerate?: undefined; path: string; title: string; onToast: (message: string) => void }

/**
 * A finished note, read in the window. The markup comes from our own notes and
 * the page's CSP allows no scripts, so it is inserted as-is.
 */
export function NoteDetail(props: Props) {
  const path = props.job ? props.job.notes! : props.path
  const title = props.job ? (props.job.title || props.job.name) : props.title
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    let cancelled = false
    setMarkdown(null)
    setError(null)
    setPlaying(false)
    vn.readNote(path)
      .then(text => { if (!cancelled) setMarkdown(text) })
      .catch(e => { if (!cancelled) setError(String((e as Error).message ?? e)) })
    return () => { cancelled = true }
  }, [path])

  // Two things the reader does not need twice: the note's own H1 (the header
  // above already shows the title) and the trailing "Source" block of file
  // paths (the header's buttons open those files).
  const body = useMemo(() => {
    const withoutSource = (markdown ?? '').split('<!-- voicenote:source -->')[0] ?? ''
    return withoutSource.replace(/^\s*#\s+.+\n+/, '')
  }, [markdown])
  const html = useMemo(() => (body ? marked.parse(body, { async: false }) : ''), [body])
  const audio = props.job?.audio ?? null

  return (
    <div className="detail">
      <header className="detail-head">
        <div>
          <h1 className="detail-title">{title}</h1>
          {props.job && (
            <div className="detail-meta">
              {friendlyTime(props.job.time)}
              {props.job.durationSeconds ? ` · 录音 ${spokenDuration(props.job.durationSeconds)}` : ''}
              {props.job.imported ? ' · 手动导入' : ''}
              {props.job.transcript && (
                <>
                  {' · '}
                  <button className="link inline" onClick={() => void vn.openPath(props.job!.transcript!)}>逐字转写稿</button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="row-actions">
          {props.job && (
            props.pending
              ? <span className="hint">已排队重新生成…</span>
              : <button onClick={props.onRegenerate} title="用保存的转写稿重写纪要,不会重新转写">重新生成</button>
          )}
          {audio && <button onClick={() => setPlaying(v => !v)}>{playing ? '收起播放' : '播放录音'}</button>}
          <button onClick={() => { void navigator.clipboard.writeText(markdown ?? ''); props.onToast('已复制 Markdown') }} disabled={!markdown}>复制</button>
          <button onClick={() => void vn.openNoteAsHtml(title, html)} disabled={!markdown}>浏览器打开</button>
          <button onClick={() => void vn.revealPath(path)}>在访达中显示</button>
        </div>
      </header>

      {playing && audio && <audio className="player" controls autoPlay src={`file://${encodeURI(audio)}`} />}

      {error && <p className="problem">读取失败：{error}</p>}
      {!markdown && !error && <p className="hint">载入中…</p>}
      {markdown && <article className="note-body" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  )
}
