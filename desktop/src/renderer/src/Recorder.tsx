import { useCallback, useEffect, useState } from 'react'
import { vn, type RecorderFile, type RecorderFiles } from './api.ts'
import { friendlyTime, spokenDuration } from './format.ts'

/** What the pipeline decided about a file, said plainly. */
const VERDICTS: Record<string, { label: string; tone: 'ready' | 'done' | 'skip' | 'bad' }> = {
  ready: { label: '待处理', tone: 'ready' },
  already_done: { label: '已处理', tone: 'done' },
  too_old: { label: '超出时间范围', tone: 'skip' },
  too_small: { label: '文件太小', tone: 'skip' },
  too_short: { label: '时长太短', tone: 'skip' },
  gave_up: { label: '多次失败后停止', tone: 'bad' },
}

function sizeLabel(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(0)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`
}

/**
 * The recorder's contents, and a way to process any single file regardless of
 * the filters. The filters exist so an automatic run does not drain a device's
 * whole history; picking a file by hand is an explicit decision and overrides
 * them.
 */
export function Recorder({ running, onClose, onToast }: {
  running: boolean
  onClose: () => void
  onToast: (message: string) => void
}) {
  const [data, setData] = useState<RecorderFiles | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')

  const load = useCallback(async () => {
    try { setData(await vn.recorderFiles()) } catch (e) { setError(String((e as Error).message ?? e)) }
  }, [])

  useEffect(() => { void load() }, [load])

  const items = data?.items ?? []
  const pending = items.filter(item => item.verdict !== 'already_done')
  const shown = filter === 'pending' ? pending : items

  const process = async (item: RecorderFile) => {
    try {
      const { queued } = await vn.runFile(item.path)
      onToast(queued ? `${item.name} 已排队,当前任务完成后开始` : `开始处理 ${item.name}`)
      onClose()   // the sidebar is where progress lives
    } catch (e) {
      onToast(String((e as Error).message ?? e))
    }
  }

  return (
    <div className="app">
      <header className="titlebar">
        <button onClick={onClose}>← 返回</button>
        <div className="brand">录音笔文件</div>
        <div className="grow" />
        <div className="segmented">
          <button className={filter === 'pending' ? 'on' : ''} onClick={() => setFilter('pending')}>未处理 {pending.length}</button>
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>全部 {items.length}</button>
        </div>
        <button onClick={() => void load()}>刷新</button>
      </header>

      <main className="sheet wide">
        {error && <p className="problem">{error}</p>}
        {!data && !error && (
          <p className="hint">
            正在读取录音笔…首次读取需要逐个校验文件,可能要几十秒;之后会直接使用缓存。
          </p>
        )}
        {data && !data.present && <p className="hint">没检测到录音笔({data.dir})。插上后点刷新。</p>}
        {data?.present && shown.length === 0 && <p className="hint">{filter === 'pending' ? '没有待处理的录音,全部处理过了。' : '这个目录里没有录音文件。'}</p>}

        {shown.map(item => {
          const verdict = VERDICTS[item.verdict] ?? { label: item.verdict, tone: 'skip' as const }
          return (
            <article key={item.sourceId} className="file-row">
              <div className="file-main">
                <div className="file-title">{item.title || item.name}</div>
                <div className="file-sub">
                  {friendlyTime(item.recordedAt.replace('T', ' '))}
                  {item.durationSeconds ? ` · ${spokenDuration(item.durationSeconds)}` : ''}
                  {` · ${sizeLabel(item.sizeBytes)}`}
                  {item.title ? ` · ${item.name}` : ''}
                </div>
              </div>
              <span className={`verdict ${verdict.tone}`} title={item.detail ?? undefined}>{verdict.label}</span>
              <button
                className={verdict.tone === 'ready' ? 'primary' : ''}
                disabled={running}
                onClick={() => void process(item)}
              >
                {item.verdict === 'already_done' ? '重新处理' : '处理'}
              </button>
            </article>
          )
        })}

        {data?.present && (
          <p className="hint fine">
            手动处理会忽略时间范围和大小限制。「重新处理」会重新转写并重写纪要,要花一次转写费用;
            只想换一版纪要的话,在纪要页用「重新生成」。
          </p>
        )}
      </main>
    </div>
  )
}
