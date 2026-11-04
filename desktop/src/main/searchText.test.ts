import { expect, test } from 'bun:test'
import { searchText } from './searchText.ts'

test('searchable excerpts omit formatting and source metadata', () => {
  const text = '# Title\n\n- **对接速度**: [文档](https://example.com)\n\n<!-- voicenote:source -->\n<details><summary>Source</summary>secret path</details>'
  expect(searchText(text)).toBe('Title 对接速度: 文档')
})
