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
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)

  useEffect(() => {
    let cancelled = false
    setMarkdown(null)
    setError(null)
    setPlaying(false)
    setConfirmRegenerate(false)
    vn.readNote(path)
      .then(text => { if (!cancelled) setMarkdown(text) })
      .catch(e => { if (!cancelled) setError(String((e as Error).message ?? e)) })
    return () => { cancelled = true }
  }, [path])

  const shareable = (markdown ?? '').split('<!-- voicenote:source -->')[0]!.trimEnd()
  const body = shareable.replace(/^\s*#\s+.+(?:\n+|$)/, '')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(/^\s*#\s+/.test(shareable) ? shareable : `# ${title}\n\n${shareable}`)
      props.onToast('已复制 Markdown')
    } catch (error) {
      props.onToast(`复制失败：${String((error as Error).message ?? error)}`)
    }
  }
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
              : <button onClick={() => setConfirmRegenerate(true)} title="用保存的转写稿重写纪要,不会重新转写">重新生成</button>
          )}
          {audio && <button onClick={() => setPlaying(v => !v)}>{playing ? '收起播放' : '播放录音'}</button>}
          <button onClick={() => void copy()} disabled={!shareable}>复制</button>
          <button onClick={() => void vn.openNoteAsHtml(title, html)} disabled={!markdown}>浏览器打开</button>
          <button onClick={() => void vn.revealPath(path)}>在访达中显示</button>
        </div>
      </header>

      {confirmRegenerate && props.job && (
        <div className="callout" role="alert">
          <p>重新生成会替换当前纪要，包括手动修改的内容。转写稿和录音会保留。</p>
          <div className="row-actions">
            <button className="primary" onClick={() => { setConfirmRegenerate(false); props.onRegenerate() }}>确认重新生成</button>
            <button onClick={() => setConfirmRegenerate(false)}>取消</button>
          </div>
        </div>
      )}

      {playing && audio && <audio className="player" controls autoPlay src={`file://${encodeURI(audio)}`} />}

      {error && <p className="problem">读取失败：{error}</p>}
      {!markdown && !error && <p className="hint">载入中…</p>}
      {markdown && <article className="note-body" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  )
}
