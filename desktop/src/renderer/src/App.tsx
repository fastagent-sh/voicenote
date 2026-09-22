import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { vn, type Job, type JobsResponse, type LoginEvent, type PipelineEvent, type Status } from './api.ts'
import { parseDraft } from './draft.ts'
import { clock, estimateRemaining, friendlyTime, isFresh, spokenDuration, timeGroup } from './format.ts'
import { explainFailure, topProblem } from './problems.ts'
import { NoteDetail } from './NoteDetail.tsx'
import { Onboarding } from './Onboarding.tsx'
import { Recorder } from './Recorder.tsx'
import { Settings } from './Settings.tsx'

/** Why a recording was never processed, in the user's words. */
const FILTER_REASONS: Record<string, string> = {
  too_old: '早于设定的时间范围',
  too_small: '文件太小',
  too_short: '时长太短',
  no_speech: '没有人声',
  bad_audio: '音频无法识别',
  ignored: '已忽略',
}

const STEPS = [
  { match: 'copy audio', label: '拷贝音频' },
  { match: 'reuse saved transcript', label: '读取转写稿' },
  { match: 'transcribe audio', label: '转写' },
  { match: 'generate', label: '生成纪要' },
  { match: 'write outputs', label: '写入' },
]

function stepIndex(step: string | null): number {
  if (!step) return 0
  const lower = step.toLowerCase()
  const found = STEPS.findIndex(s => lower.startsWith(s.match))
  return found < 0 ? 0 : found
}

type Live = {
  id: string | null
  step: string | null
  durationSeconds: number | null
  note: string
  tool: string | null
  startedAt: number
}

const EMPTY_LIVE: Live = { id: null, step: null, durationSeconds: null, note: '', tool: null, startedAt: Date.now() }

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return <span className="mono">{clock((now - since) / 1000)}</span>
}

/** The running recording: what it is, where it is, and what it has written. */
function ActiveDetail({ job, live }: { job: Job; live: Live }) {
  const endRef = useRef<HTMLDivElement>(null)
  // Follow the growing draft until the reader scrolls up, then leave them
  // alone until they come back to the bottom. Deciding per delta does not
  // work: one paragraph can arrive at once and land further from the bottom
  // than any threshold, which silently ends the follow.
  const following = useRef(true)
  useEffect(() => {
    const pane = document.querySelector<HTMLElement>('.main')
    if (!pane) return
    const onScroll = () => {
      following.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80
    }
    pane.addEventListener('scroll', onScroll, { passive: true })
    return () => pane.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    if (following.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [live.note])

  // The body opens with its own H1, so the title field is not rendered again.
  const draft = parseDraft(live.note)
  const draftHtml = draft.body ? marked.parse(draft.body, { async: false }) : ''

  const index = stepIndex(live.step ?? job.step)
  const duration = live.durationSeconds ?? job.durationSeconds
  const estimate = estimateRemaining(duration)
  const waiting = [
    '正在把音频拷进工作目录…',
    '正在读取已保存的转写稿…',
    `正在转写${estimate ? `,${estimate}` : ''}…`,
    '模型正在通读全文并写纪要…',
    '正在写入文件…',
  ][index]

  return (
    <div className="detail">
      <header className="detail-head">
        <div>
          <h1 className="detail-title">{job.title || job.name}</h1>
          <div className="detail-meta">
            处理中 · 已用 <Elapsed since={live.startedAt} />
            {duration ? ` · 录音 ${spokenDuration(duration)}` : ''}
          </div>
        </div>
      </header>

      <ol className="steps">
        {STEPS.filter(s => s.match !== 'reuse saved transcript').map((s, i) => {
          const position = i >= 1 ? i + 1 : i   // skip the resume-only step in the display
          return (
            <li key={s.label} className={position < index ? 'done' : position === index ? 'active' : ''}>
              <span className="step-mark" />{s.label}
            </li>
          )
        })}
      </ol>

      {live.tool && <div className="tool-hint">正在查阅历史笔记,对齐人名和项目称呼…</div>}
      {draft.body
        ? (
          <>
            <article className="note-body draft" dangerouslySetInnerHTML={{ __html: draftHtml + '<span class="caret"></span>' }} />
            <div ref={endRef} />
            <p className="hint fine">正在实时生成,写完后会自动保存。</p>
          </>
        )
        : <div className="waiting"><span className="pulse" />{waiting}</div>}
    </div>
  )
}

function FailureDetail({ job, pending, onRetry, onIgnore, onLogin, onSettings, onOpen }: {
  job: Job
  pending: boolean
  onRetry: () => void
  onIgnore: () => void
  onLogin: () => void
  onSettings: () => void
  onOpen: (path: string) => void
}) {
  const [raw, setRaw] = useState(false)
  const problem = explainFailure(job)
  return (
    <div className="detail">
      <header className="detail-head">
        <div>
          <h1 className="detail-title">{job.title || job.name}</h1>
          <div className="detail-meta">{friendlyTime(job.time)}{job.durationSeconds ? ` · ${spokenDuration(job.durationSeconds)}` : ''}</div>
        </div>
      </header>
      <div className={pending ? 'callout callout-pending' : 'callout'}>
        <p className="callout-title">{pending ? '已排队重试,当前任务完成后自动开始。' : problem.message}</p>
        {!pending && problem.attempts && <p className="hint">{problem.attempts}</p>}
        {pending && <p className="hint">原因：{problem.message}</p>}
        <div className="row-actions">
          {!pending && problem.action?.kind === 'login' && <button className="primary" onClick={onLogin}>{problem.action.label}</button>}
          {!pending && problem.action?.kind === 'settings' && <button className="primary" onClick={onSettings}>{problem.action.label}</button>}
          {!pending && problem.action?.kind === 'retry' && job.id && <button className="primary" onClick={onRetry}>重试</button>}
          {job.transcript && <button onClick={() => onOpen(job.transcript!)}>打开转写稿</button>}
          {/* Every failure needs a way out, including the ones a retry cannot fix. */}
          {!pending && job.id && <button onClick={onIgnore}>不再处理这条</button>}
          {job.detail && <button className="link" onClick={() => setRaw(v => !v)}>{raw ? '收起原始错误' : '原始错误'}</button>}
        </div>
        {raw && <pre className="raw-error">{job.detail}</pre>}
      </div>
      {job.transcript
        ? <p className="hint">转写稿已经保存,重试只会重新生成纪要,不会重复花费转写费用。</p>
        : <p className="hint">「不再处理这条」只是把它从列表里移走,录音笔上的文件不会被删除。</p>}
    </div>
  )
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [jobs, setJobs] = useState<JobsResponse | null>(null)
  const [live, setLive] = useState<Live>(EMPTY_LIVE)
  const [running, setRunning] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ path: string; title: string; snippet: string }[]>([])
  const [selected, setSelected] = useState<{ kind: 'job'; id: string } | { kind: 'path'; path: string; title: string } | null>(null)
  const [screen, setScreen] = useState<'main' | 'settings' | 'recorder'>('main')
  const [skipSetup, setSkipSetup] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [pendingRetries, setPendingRetries] = useState<string[]>([])
  const [queuedRuns, setQueuedRuns] = useState(0)
  const [update, setUpdate] = useState<{ available: string | null; ready: string | null }>({ available: null, ready: null })

  /** Every user action goes through here: a failure must be visible. */
  const act = useCallback(async (work: () => Promise<unknown>, done?: string) => {
    try {
      const result = await work()
      if (result && typeof result === 'object' && 'queued' in result && (result as { queued: boolean }).queued) {
        setToast('已排队,当前这条处理完就开始')
      } else if (done) setToast(done)
    } catch (error) {
      setToast(String((error as Error)?.message ?? error))
    }
  }, [])

  const refresh = useCallback(async () => {
    const [nextStatus, nextJobs] = await Promise.all([vn.status(), vn.jobs(200)])
    setStatus(nextStatus)
    setJobs(nextJobs)
  }, [])

  useEffect(() => {
    void refresh()
    void vn.pendingRetries().then(setPendingRetries)
    void vn.updateState().then(state => setUpdate(u => ({ ...u, ready: state.ready })))
    const poll = setInterval(() => { void vn.jobs(200).then(setJobs) }, 2000)
    const off = [
      vn.on('pipeline:event', (event: PipelineEvent) => {
        if (event.type === 'job_start') setLive({ id: event.id, step: null, durationSeconds: event.durationSeconds, note: '', tool: null, startedAt: Date.now() })
        else if (event.type === 'job_step') setLive(prev => ({ ...prev, step: event.step, note: event.step.toLowerCase().startsWith('generate') ? '' : prev.note }))
        else if (event.type === 'note_delta') setLive(prev => ({ ...prev, note: prev.note + event.delta }))
        else if (event.type === 'note_tool') setLive(prev => ({ ...prev, tool: event.name }))
        else if (event.type === 'job_done') {
          setToast(event.stub ? '转写完成,但纪要没能生成' : `已完成：${event.title ?? ''}`)
          // The list is ordered by recording date, so a note made from an old
          // recording appears far down it. Show it instead of making the user
          // hunt for what just finished.
          if (!event.stub) setSelected({ kind: 'job', id: event.id })
          void refresh()
        }
        else if (event.type === 'job_failed') { setToast('处理失败,见列表中的提示'); void refresh() }
      }),
      vn.on('run:state', (state: { running: boolean }) => {
        setRunning(state.running)
        if (!state.running) setLive(EMPTY_LIVE)
        void refresh()
      }),
      vn.on('run:error', (message: string) => setToast(message)),
      vn.on('retry:pending', (ids: string[]) => setPendingRetries(ids)),
      vn.on('run:queued', (count: number) => setQueuedRuns(count)),
      vn.on('update:available', (version: string) => setUpdate(u => ({ ...u, available: version }))),
      vn.on('update:ready', (version: string) => setUpdate(u => ({ ...u, ready: version }))),
      vn.on('recorder:connected', () => setToast('检测到录音笔,开始处理')),
      vn.on('login:event', (event: LoginEvent) => {
        if (event.event === 'success') { setToast('已登录 ChatGPT'); void refresh() }
        else if (event.event === 'error') setToast(`登录失败：${event.message}`)
        else if (event.event === 'auth_url') setToast('已打开浏览器,授权后自动继续')
      }),
    ]
    return () => { clearInterval(poll); off.forEach(fn => fn()) }
  }, [refresh])

  useEffect(() => {
    if (query.trim().length < 2) { setHits([]); return }
    const id = setTimeout(() => { void vn.search(query).then(setHits) }, 200)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(id)
  }, [toast])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.search input')?.focus()
      }
      if (event.key === 'Escape') { setQuery(''); setSelected(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const items = jobs?.items ?? []
  const active = items.find(job => job.status === 'running') ?? null
  const filteredRow = items.find(job => job.status === 'filtered') ?? null
  const attention = items.filter(job => ['error', 'notes_failed', 'gave_up'].includes(job.status))
  const queued = items.filter(job => job.status === 'queued')

  const notes = useMemo(() => {
    const done = items.filter(job => job.status === 'done')
    if (!query.trim()) return done
    const needle = query.trim().toLowerCase()
    return done.filter(job => `${job.title ?? ''} ${job.name}`.toLowerCase().includes(needle))
  }, [items, query])

  const grouped = useMemo(() => {
    const groups = new Map<string, Job[]>()
    for (const job of notes) {
      const key = timeGroup(job.time)
      groups.set(key, [...(groups.get(key) ?? []), job])
    }
    return [...groups.entries()]
  }, [notes])

  // Keep a selection alive across refreshes, and follow the running job.
  const selectedJob = selected?.kind === 'job' ? items.find(job => job.id === selected.id) ?? null : null
  useEffect(() => {
    if (!selected && active) setSelected({ kind: 'job', id: active.id! })
  }, [active, selected])

  // Only the recordings a person might actually want processed are counted:
  // a two-second accidental press is not a to-do item.
  const SCRAP_CODES = ['too_small', 'too_short', 'no_speech', 'bad_audio', 'ignored']
  const byCode = filteredRow?.filtered?.byCode ?? {}
  const skipped = Object.entries(byCode)
    .filter(([code]) => !SCRAP_CODES.includes(code))
    .reduce((total, [, count]) => total + count, 0)
  const problem = topProblem(status)

  if (screen === 'settings') {
    return <Settings status={status} onClose={() => { setScreen('main'); void refresh() }} onLogin={() => vn.login()} />
  }
  if (screen === 'recorder') {
    return <Recorder running={running} onClose={() => { setScreen('main'); void refresh() }} onToast={setToast} />
  }
  if (!skipSetup && status !== null && (!status.volcano.configured || !status.pi.auth)) {
    // `refresh` itself, not a fresh arrow per render: Onboarding keys an effect
    // on this prop, and a new identity every render reloaded the saved config
    // over whatever the user was typing.
    return <Onboarding status={status} onDone={() => setSkipSetup(true)} onRefresh={refresh} />
  }

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault()
    setDropping(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    const path = vn.pathForFile(file)
    if (path) await act(() => vn.importRecording(path), `已加入队列：${file.name}`)
  }

  return (
    <div
      className={dropping ? 'shell dropping' : 'shell'}
      onDragOver={e => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">VoiceNote</div>
          <div className={status?.recorder.exists ? 'pill ok' : 'pill'}>
            {status?.recorder.exists ? '录音笔已连接' : '未连接录音笔'}
          </div>
        </div>

        <div className="search"><input placeholder="搜索纪要  ⌘F" value={query} onChange={e => setQuery(e.target.value)} /></div>

        <button className="device-card" onClick={() => setScreen('recorder')}>
          <span className="device-main">
            <span className="device-title">录音笔文件</span>
            <span className="device-sub">
              {status?.recorder.exists
                ? (skipped > 0 ? `${skipped} 个录音待处理,点这里查看` : '全部处理完了,点这里查看')
                : '未连接 · 仍可查看上次的列表'}
            </span>
          </span>
          {skipped > 0 && <span className="device-badge">{skipped}</span>}
        </button>

        <nav className="list">
          {active && (
            <button className={selected?.kind === 'job' && selected.id === active.id ? 'row row-active selected' : 'row row-active'} onClick={() => setSelected({ kind: 'job', id: active.id! })}>
              <span className="spinner" />
              <span className="row-main">
                <span className="row-title">{active.title || active.name}</span>
                <span className="row-sub">处理中 · <Elapsed since={live.startedAt} /></span>
              </span>
            </button>
          )}

          {queued.map(job => (
            <button key={job.id} className="row" onClick={() => setSelected({ kind: 'job', id: job.id! })}>
              <span className="row-main">
                <span className="row-title">{job.title || job.name}</span>
                <span className="row-sub">排队中</span>
              </span>
            </button>
          ))}

          {attention.length > 0 && <div className="group-head">需要处理</div>}
          {attention.map(job => (
            <button key={job.id} className={`row ${job.id && pendingRetries.includes(job.id) ? 'row-pending' : 'row-failed'}${selected?.kind === 'job' && selected.id === job.id ? ' selected' : ''}`} onClick={() => setSelected({ kind: 'job', id: job.id! })}>
              <span className="row-main">
                <span className="row-title">{job.title || job.name}</span>
                <span className="row-sub">{job.id && pendingRetries.includes(job.id) ? '等待重试,当前任务完成后开始' : explainFailure(job).message}</span>
              </span>
            </button>
          ))}

          {hits.length > 0 && <div className="group-head">正文匹配</div>}
          {hits.map(hit => (
            <button key={hit.path} className={selected?.kind === 'path' && selected.path === hit.path ? 'row selected' : 'row'} onClick={() => setSelected({ kind: 'path', path: hit.path, title: hit.title })}>
              <span className="row-main">
                <span className="row-title">{hit.title}</span>
                <span className="row-sub">…{hit.snippet}…</span>
              </span>
            </button>
          ))}

          {grouped.map(([group, groupJobs]) => (
            <div key={group}>
              <div className="group-head">{group}</div>
              {groupJobs.map(job => (
                <button key={job.id} className={selected?.kind === 'job' && selected.id === job.id ? 'row selected' : 'row'} onClick={() => setSelected({ kind: 'job', id: job.id! })}>
                  <span className="row-main">
                    <span className="row-title">
                      {isFresh(job.finishedAt) && <span className="fresh">刚生成</span>}
                      {job.title || job.name}
                    </span>
                    <span className="row-sub">{friendlyTime(job.time)}{job.durationSeconds ? ` · ${spokenDuration(job.durationSeconds)}` : ''}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}

          {!items.length && <div className="sidebar-empty">还没有纪要</div>}
        </nav>

        <div className="sidebar-foot">
          <button className="primary" onClick={() => void act(() => vn.run())} disabled={running}>
            {running ? (queuedRuns > 0 ? `处理中 · 还有 ${queuedRuns}` : '处理中…') : '立即处理'}
          </button>
          <button onClick={() => void act(async () => { const path = await vn.pickAudio(); if (path) await vn.importRecording(path) }, '已加入队列')}>导入</button>
          <button onClick={() => setScreen('settings')} title="设置">⚙</button>
        </div>
      </aside>

      <main className="main">
        <div className="titlebar-drag" />
        {update.ready && (
          <div className="callout callout-top callout-update">
            <span>新版本 {update.ready} 已下载{running ? ',当前处理完成后再重启' : ''}。</span>
            <button className="primary" onClick={() => void vn.installUpdate()} disabled={running}>重启以更新</button>
          </div>
        )}
        {!update.ready && update.available && (
          <div className="callout callout-top callout-update">
            <span>发现新版本 {update.available},正在后台下载…</span>
          </div>
        )}
        {problem && (
          <div className="callout callout-top">
            <span>{problem.message}</span>
            {problem.action?.kind === 'login' && <button className="primary" onClick={() => void act(() => vn.login())}>{problem.action.label}</button>}
            {problem.action?.kind === 'settings' && <button className="primary" onClick={() => setScreen('settings')}>{problem.action.label}</button>}
          </div>
        )}

        {selectedJob?.status === 'running' && <ActiveDetail job={selectedJob} live={live} />}
        {selectedJob && ['error', 'notes_failed', 'gave_up'].includes(selectedJob.status) && (
          <FailureDetail
            job={selectedJob}
            pending={!!selectedJob.id && pendingRetries.includes(selectedJob.id)}
            onRetry={() => { if (selectedJob.id) void act(() => vn.retry(selectedJob.id!), '已加入重试队列') }}
            onIgnore={() => { if (selectedJob.id) { void act(() => vn.ignore(selectedJob.id!), '已移出列表'); setSelected(null) } }}
            onLogin={() => void act(() => vn.login())}
            onSettings={() => setScreen('settings')}
            onOpen={(path) => void act(() => vn.openPath(path))}
          />
        )}
        {selectedJob?.status === 'done' && selectedJob.notes && (
          <NoteDetail
            job={selectedJob}
            pending={!!selectedJob.id && pendingRetries.includes(selectedJob.id)}
            onRegenerate={() => { if (selectedJob.id) void act(() => vn.regenerate(selectedJob.id!), '已开始重新生成') }}
            onToast={setToast}
          />
        )}
        {selected?.kind === 'path' && <NoteDetail path={selected.path} title={selected.title} onToast={setToast} />}
        {!selected && (
          <div className="placeholder">
            <div className="placeholder-art">🎙️</div>
            <p>插上录音笔,或把音频文件拖进窗口。</p>
            <p className="hint">处理过程会在左侧显示,纪要写完后出现在这里。</p>
          </div>
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
      {dropping && <div className="drop-overlay">松手即可导入</div>}
    </div>
  )
}
