import { createInterface } from 'node:readline/promises'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

export type LoginInteraction = Parameters<ModelRuntime['login']>[2]
export type LoginPrompt = Parameters<LoginInteraction['prompt']>[0]
type WithoutSignal<T> = T extends unknown ? Omit<T, 'signal'> : never
export type LoginPromptView = WithoutSignal<LoginPrompt>

export async function promptInTerminal(prompt: LoginPrompt, loginSignal: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const signal = AbortSignal.any([loginSignal, controller.signal, ...(prompt.signal ? [prompt.signal] : [])])
  signal.throwIfAborted()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const cancel = () => controller.abort(new Error('Login cancelled: terminal input closed'))
  rl.once('SIGINT', cancel)
  rl.once('close', cancel)
  try {
    const options = prompt.type === 'select'
      ? `\n${prompt.options.map(o => `  ${o.id}: ${o.label}`).join('\n')}\n`
      : ''
    const answer = (await rl.question(`${options}${prompt.message} `, { signal })).trim()
    if (prompt.type === 'select' && !prompt.options.some(o => o.id === answer)) {
      throw new Error(`Unknown login option '${answer}'`)
    }
    return answer
  } finally {
    rl.removeListener('close', cancel)
    rl.removeListener('SIGINT', cancel)
    rl.close()
  }
}

export class LoginPrompts {
  private nextId = 0
  private pending?: { id: number; resolve: (value: string) => void }

  private send: (event: Record<string, unknown>) => void

  constructor(send: (event: Record<string, unknown>) => void) {
    this.send = send
  }

  ask(prompt: LoginPrompt, signal: AbortSignal): Promise<string> {
    signal = AbortSignal.any([signal, ...(prompt.signal ? [prompt.signal] : [])])
    signal.throwIfAborted()
    if (this.pending) throw new Error('Another login prompt is awaiting a response')
    const id = ++this.nextId
    return new Promise<string>((resolve, reject) => {
      const finish = () => {
        this.pending = undefined
        signal.removeEventListener('abort', abort)
        this.send({ event: 'prompt_closed', id })
      }
      const abort = () => { finish(); reject(signal.reason) }
      this.pending = { id, resolve: value => { finish(); resolve(value) } }
      signal.addEventListener('abort', abort, { once: true })
      const { signal: _signal, ...view } = prompt
      this.send({ event: 'prompt', id, prompt: view })
    })
  }

  answer(id: number, value: string): void {
    if (this.pending?.id !== id) throw new Error('Login prompt is no longer active')
    this.pending.resolve(value)
  }
}
