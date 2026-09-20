import type { Status } from './api.ts'

/** A problem the user can act on: one sentence, one button. */
export type Problem = {
  message: string
  action?: { label: string; kind: 'login' | 'settings' | 'retry' }
}

/**
 * Turns a raw failure string into something a person can act on. Anything
 * unrecognised keeps its original text — a wrong guess is worse than a blunt
 * error, and the raw text stays available under "详情" either way.
 */
export function explainFailure(detail: string | null): Problem {
  const text = (detail ?? '').toLowerCase()
  if (!text) return { message: '处理失败,原因未记录。', action: { label: '重试', kind: 'retry' } }
  if (/no api key|unauthorized|invalid.*(key|token|credential)|401|oauth/.test(text)) {
    return { message: 'ChatGPT 登录已失效,纪要没能生成。', action: { label: '重新登录', kind: 'login' } }
  }
  if (/quota|usage limit|rate limit|429|billing|credit/.test(text)) {
    return { message: '模型额度用完了,过一会儿再试。', action: { label: '重试', kind: 'retry' } }
  }
  if (/fetch failed|socket|econnreset|etimedout|enetunreach|econnrefused|network|timed ?out/.test(text)) {
    return { message: '网络没连上,可能需要代理。', action: { label: '重试', kind: 'retry' } }
  }
  if (/volcano|asr|45000|20000003/.test(text)) {
    if (/silent|20000003/.test(text)) return { message: '这段录音里没有检测到人声。' }
    if (/invalid|45000/.test(text)) return { message: '转写服务不接受这个音频文件。' }
    return { message: '转写失败了。', action: { label: '重试', kind: 'retry' } }
  }
  return { message: detail!, action: { label: '重试', kind: 'retry' } }
}

/** The one thing most worth fixing right now, or null when nothing is wrong. */
export function topProblem(status: Status | null): Problem | null {
  if (!status) return null
  if (!status.volcano.configured) return { message: '还没填转写密钥,录音无法处理。', action: { label: '去设置', kind: 'settings' } }
  if (!status.pi.available) return { message: '纪要引擎没能加载,请重新安装。' }
  if (!status.pi.auth) return { message: '还没登录 ChatGPT,纪要无法生成。', action: { label: '登录', kind: 'login' } }
  return null
}
