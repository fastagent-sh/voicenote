import type { Job, Status } from './api.ts'

/** A problem the user can act on: one sentence, one button. */
export type Problem = {
  message: string
  /** "第 1 次尝试,共 3 次" — the machinery behind the message, kept small. */
  attempts?: string
  action?: { label: string; kind: 'login' | 'settings' | 'retry' }
}

const RETRY = { label: '重试', kind: 'retry' } as const
const LOGIN = { label: '重新登录', kind: 'login' } as const
const SETTINGS = { label: '去设置', kind: 'settings' } as const

/** `… (attempt 2/3)` / `… — gave up after 3 attempts; …` → a short Chinese note. */
function attemptsNote(detail: string): string | undefined {
  const attempt = detail.match(/\(attempt (\d+)\/(\d+)\)/)
  if (attempt) return `第 ${attempt[1]} 次尝试,共 ${attempt[2]} 次`
  const gaveUp = detail.match(/gave up after (\d+) attempts/)
  if (gaveUp) return `已尝试 ${gaveUp[1]} 次,不再自动重试`
  return undefined
}

/**
 * Turns a failure into something a person can act on. The job's `code` says
 * which stage broke; the raw text only refines the reason. Anything
 * unrecognised keeps its original text — a confident wrong guess is worse than
 * a blunt error, and the raw text stays available behind "原始错误".
 */
export function explainFailure(job: Pick<Job, 'code' | 'detail'> | string | null): Problem {
  const detail = typeof job === 'string' ? job : (job?.detail ?? '')
  const code = typeof job === 'string' || !job ? null : job.code
  const text = detail.toLowerCase()
  const attempts = detail ? attemptsNote(detail) : undefined
  const problem = (message: string, action?: Problem['action']): Problem =>
    ({ message, ...(attempts ? { attempts } : {}), ...(action ? { action } : {}) })

  if (code === 'interrupted') {
    return problem('上次处理没跑完就被打断了(退出应用、电脑休眠或断电)。', RETRY)
  }
  if (/no api key|unauthorized|invalid.*(key|token|credential)|\b401\b|oauth/.test(text)) {
    return problem('ChatGPT 登录已失效,纪要没能生成。', LOGIN)
  }
  if (/quota|usage limit|rate limit|\b429\b|billing|credit/.test(text)) {
    return problem('模型额度用完了,过一会儿再试。', RETRY)
  }
  if (/fetch failed|socket|econnreset|etimedout|enetunreach|econnrefused|network|timed ?out/.test(text)) {
    return problem('网络没连上。如果需要代理,先在设置里填好再重试。', RETRY)
  }
  if (/20000003|no valid speech|silent/.test(text)) {
    return problem('这段录音里没有检测到人声,跳过即可。')
  }
  if (/45000|invalid audio|audio convert failed/.test(text)) {
    return problem('转写服务不接受这个音频文件(格式或内容有问题)。')
  }
  if (/enoent|no such file|left the recorder/.test(text)) {
    return problem('找不到原始录音文件,可能录音笔被拔掉或文件被移动了。')
  }
  if (code === 'transcribe_failed') return problem('转写失败了。', RETRY)
  if (code === 'summary_failed') return problem('转写成功,但纪要没能生成。', RETRY)
  if (!detail) return problem('处理失败,原因未记录。', RETRY)
  return problem(detail, RETRY)
}

/** The one thing most worth fixing right now, or null when nothing is wrong. */
export function topProblem(status: Status | null): Problem | null {
  if (!status) return null
  if (!status.volcano.configured) return { message: '还没填转写密钥,录音无法处理。', action: SETTINGS }
  if (!status.pi.available) return { message: '纪要引擎没能加载,请重新安装应用。' }
  if (!status.pi.auth) return { message: '还没登录 ChatGPT,纪要无法生成。', action: { label: '登录', kind: 'login' } }
  return null
}
