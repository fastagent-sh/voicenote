import { expect, test } from 'bun:test'
import { LoginPrompts } from './loginInteraction.ts'

test('desktop login prompts accept input and reject stale replies', async () => {
  const events: Record<string, unknown>[] = []
  const prompts = new LoginPrompts(event => events.push(event))
  const answer = prompts.ask({ type: 'text', message: 'Enterprise domain' }, new AbortController().signal)
  const id = events[0]!.id as number
  prompts.answer(id, 'example.com')
  expect(await answer).toBe('example.com')
  expect(events[1]).toEqual({ event: 'prompt_closed', id })
  expect(() => prompts.answer(id, 'again')).toThrow('no longer active')
})

test('desktop login prompts close when cancelled or superseded by a browser callback', async () => {
  for (const reason of ['Login cancelled', 'Browser callback completed', 'Login timed out']) {
    const events: Record<string, unknown>[] = []
    const prompts = new LoginPrompts(event => events.push(event))
    const controller = new AbortController()
    const answer = prompts.ask({ type: 'manual_code', message: 'Paste callback URL', signal: controller.signal }, new AbortController().signal)
    controller.abort(new Error(reason))
    await expect(answer).rejects.toThrow(reason)
    expect(events[1]?.event).toBe('prompt_closed')
  }
})

test('desktop login refuses already aborted prompts', () => {
  const prompts = new LoginPrompts(() => { throw new Error('Should not display a cancelled prompt') })
  expect(() => prompts.ask({ type: 'text', message: 'Code' }, AbortSignal.abort(new Error('cancelled')))).toThrow('cancelled')
})
