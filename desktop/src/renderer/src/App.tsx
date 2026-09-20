import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { vn, type Job, type JobsResponse, type LoginEvent, type Status } from './api.ts'
import { explainFailure, topProblem } from './problems.ts'
import { NoteReader } from './NoteReader.tsx'
import { Onboarding } from './Onboarding.tsx'
import { Settings } from './Settings.tsx'

const STEP_ORDER = ['Copy audio', 'Transcribe audio', 'Generate', 'Write outputs']

/** Why a recording was never processed, in the user's words. */
const FILTER_REASONS: Record<string, string> = {
  too_old: '早于设定的时间范围',
  too_small: '文件太小',
  too_short: '时长太短',
}

/** Progress the state file can express: which of the four steps is running. */
function stepIndex(step: string | null): number {
  if (!step) return 0
  const found = STEP_ORDER.findIndex(prefix => step.toLowerCase().startsWith(prefix.toLowerCase()))
  return found < 0 ? 0 : found
}

function Timer({ since }: { since: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.floor((Date.now() - since) / 1000)
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return <span className="timer">{mm}:{ss}</span>
}

function ActiveCard({ job, note, tool, startedAt }: { job: Job; note: string; tool: string | null; startedAt: number }) {
  const bodyRef = useRef<HTMLPreElement>(null)
  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }) }, [note])
  const index = stepIndex(job.step)
  return (
    <article className="card card-active">
      <header>
        <div>
          <div className="card-title">{job.title || job.name}</div>
          <div className="card-sub">{job.time ?? ''}</div>
        </div>
        <Timer since={startedAt} />
      </header>
      <ol className="steps">
        {['拷贝音频', '转写', '生成纪要', '写入'].map((label, i) => (
          <li key={label} className={i < index ? 'done' : i === index ? 'active' : ''}>{label}</li>
        ))}
      </ol>
      {tool && <div className="tool-hint">正在查阅 {tool}</div>}
      {note
        ? <pre className="note-stream" ref={bodyRef}>{note}</pre>
        : <div className="waiting">{['正在拷贝音频…', '正在转写,长录音需要几分钟…', '正在生成纪要…', '正在写入文件…'][index]}</div>}
    </article>
  )
}

function JobCard({ job, onRetry, onRead, onLogin, onSettings }: {
  job: Job
  onRetry: (job: Job) => void
  onRead: (job: Job) => void
  onLogin: () => void
  onSettings: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (job.status === 'filtered') {
    const reasons = Object.entries(job.filtered?.byCode ?? {})
      .map(([code, count]) => `${FILTER_REASONS[code] ?? code} ${count} 个`)
      .join('、')
    return (
      <article className="card card-muted">
        <div className="card-title">{job.filtered?.total ?? 0} 个录音被跳过</div>
        <div className="card-sub">{reasons || job.detail}</div>
        {job.history_filtered && <div className="card-actions"><button onClick={onSettings}>放宽时间范围</button></div>}
      </article>
    )
  }
  const failed = job.status === 'error' || job.status === 'notes_failed' || job.status === 'gave_up'
  if (failed) {
    const problem = explainFailure(job.detail)
    return (
      <article className="card card-failed">
        <div className="card-title">{job.title || job.name}</div>
        <div className="card-sub">{job.time ?? ''}</div>
        <p className="problem">{problem.message}</p>
        <div className="card-actions">
          {problem.action?.kind === 'login' && <button className="primary" onClick={onLogin}>{problem.action.label}</button>}
          {problem.action?.kind === 'settings' && <button className="primary" onClick={onSettings}>{problem.action.label}</button>}
          {problem.action?.kind === 'retry' && job.id && <button className="primary" onClick={() => onRetry(job)}>{problem.action.label}</button>}
          {job.notes && <button onClick={() => onRead(job)}>查看已保存内容</button>}
          {job.detail && <button className="link" onClick={() => setExpanded(v => !v)}>{expanded ? '收起' : '详情'}</button>}
        </div>
        {expanded && <pre className="raw-error">{job.detail}</pre>}
      </article>
    )
  }
  return (
    <article className={job.notes ? 'card card-openable' : 'card'} onClick={() => job.notes && onRead(job)}>
      <div className="card-row">
        <div>
          <div className="card-title">{job.title || job.name}</div>
          <div className="card-sub">{job.time ?? ''}{job.status === 'queued' ? ' · 排队中' : ''}</div>
        </div>
        {job.notes && <span className="chevron">›</span>}
      </div>
    </article>
  )
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [jobs, setJobs] = useState<JobsResponse | null>(null)
  const [note, setNote] = useState('')
  const [tool, setTool] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [startedAt, setStartedAt] = useState(Date.now())
  const [query, setQuery] = useState('')
  const [screen, setScreen] = useState<'timeline' | 'settings'>('timeline')
  const [reading, setReading] = useState<Job | null>(null)
  const [readingPath, setReadingPath] = useState<{ path: string; title: string } | null>(null)
  const [hits, setHits] = useState<{ path: string; title: string; snippet: string }[]>([])
  const [skipSetup, setSkipSetup] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [nextStatus, nextJobs] = await Promise.all([vn.status(), vn.jobs(50)])
    setStatus(nextStatus)
    setJobs(nextJobs)
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => { void vn.jobs(50).then(setJobs) }, 2000)
    const off = [
      vn.on('pipeline:event', (event) => {
        if (event.type === 'note_delta') setNote(prev => prev + event.delta)
        else setTool(event.name)
      }),
      vn.on('run:state', (state: { running: boolean }) => {
        setRunning(state.running)
        if (state.running) { setNote(''); setTool(null); setStartedAt(Date.now()) }
        void refresh()
      }),
      vn.on('run:error', (message: string) => setBanner(message)),
      vn.on('recorder:connected', () => setBanner('检测到录音笔,开始处理')),
      vn.on('login:event', (event: LoginEvent) => {
        if (event.event === 'success') { setBanner('已登录 ChatGPT'); void refresh() }
        if (event.event === 'error') setBanner(`登录失败：${event.message}`)
        if (event.event === 'auth_url') setBanner('已打开浏览器,授权后自动继续')
      }),
      vn.on('login:event', () => {}),
    ]
    return () => { clearInterval(id); off.forEach(fn => fn()) }
  }, [refresh])

  // Search runs over the notes on disk; the title filter below is instant, so
  // this only adds body matches.
  useEffect(() => {
    if (query.trim().length < 2) { setHits([]); return }
    const id = setTimeout(() => { void vn.search(query).then(setHits) }, 200)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.search')?.focus()
      }
      if (event.key === 'Escape') { setReading(null); setReadingPath(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!banner) return
    const id = setTimeout(() => setBanner(null), 6000)
    return () => clearTimeout(id)
  }, [banner])

  const onDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (!file) return
    const path = vn.pathForFile(file)
    if (path) await vn.importRecording(path)
  }, [])

  const items = jobs?.items ?? []
  const active = items.find(job => job.status === 'running') ?? null
  const rest = useMemo(() => {
    const filtered = items.filter(job => job !== active)
    if (!query.trim()) return filtered
    const needle = query.trim().toLowerCase()
    return filtered.filter(job => `${job.title ?? ''} ${job.name}`.toLowerCase().includes(needle))
  }, [items, active, query])

  const problem = topProblem(status)

  if (reading) return <NoteReader path={reading.notes!} title={reading.title || reading.name} onClose={() => setReading(null)} />
  if (readingPath) return <NoteReader path={readingPath.path} title={readingPath.title} onClose={() => setReadingPath(null)} />

  const needsSetup = !skipSetup && status !== null && (!status.volcano.configured || !status.pi.auth)
  if (needsSetup) {
    return <Onboarding status={status} onDone={() => setSkipSetup(true)} onRefresh={() => void refresh()} />
  }

  if (screen === 'settings') {
    return <Settings onClose={() => { setScreen('timeline'); void refresh() }} onLogin={() => vn.login()} status={status} />
  }

  return (
    <div className="app" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
      <header className="titlebar">
        <div className="brand">VoiceNote</div>
        <div className="grow" />
        <input className="search" placeholder="搜索纪要" value={query} onChange={e => setQuery(e.target.value)} />
        <button onClick={() => void vn.run()} disabled={running}>{running ? '处理中' : '立即处理'}</button>
        <button onClick={async () => { const path = await vn.pickAudio(); if (path) await vn.importRecording(path) }}>导入音频</button>
        <button onClick={() => setScreen('settings')}>设置</button>
      </header>

      {banner && <div className="banner">{banner}</div>}
      {problem && (
        <div className="banner banner-problem">
          <span>{problem.message}</span>
          {problem.action?.kind === 'login' && <button onClick={() => void vn.login()}>{problem.action.label}</button>}
          {problem.action?.kind === 'settings' && <button onClick={() => setScreen('settings')}>{problem.action.label}</button>}
        </div>
      )}
      {!problem && status && (
        <div className="subtle-bar">
          {status.recorder.exists ? '录音笔已连接' : '录音笔未连接'}
          {jobs && jobs.queued_total > 0 ? ` · ${jobs.queued_total} 个待处理` : ''}
        </div>
      )}

      <main className="timeline">
        {active && <ActiveCard job={active} note={note} tool={tool} startedAt={startedAt} />}
        {!active && !rest.length && <div className="empty">还没有纪要。插上录音笔,或把音频拖进这个窗口。</div>}
        {hits.length > 0 && (
          <section className="hits">
            <h4>正文里提到「{query.trim()}」</h4>
            {hits.map(hit => (
              <article key={hit.path} className="card card-openable" onClick={() => setReadingPath({ path: hit.path, title: hit.title })}>
                <div className="card-title">{hit.title}</div>
                <div className="card-sub snippet">…{hit.snippet}…</div>
              </article>
            ))}
          </section>
        )}
        {rest.map(job => (
          <JobCard
            key={job.id ?? job.name}
            job={job}
            onRetry={(target) => { if (target.id) void vn.retry(target.id) }}
            onRead={(target) => setReading(target)}
            onLogin={() => void vn.login()}
            onSettings={() => setScreen('settings')}
          />
        ))}
      </main>
    </div>
  )
}
