import { describe, expect, it } from 'vitest'
import { aroundChanges, lineDiff } from './line-diff'

describe('lineDiff', () => {
  it('marks the lines taken out and put in, and keeps the rest', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ])
    expect(lineDiff('a', 'a')).toEqual([{ kind: 'same', text: 'a' }])
  })

  it('shows a few lines around each change and marks the gaps', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n')
    const after = ['1', 'two', '3', '4', '5', '6', '7', '8', 'nine'].join('\n')
    expect(aroundChanges(lineDiff(before, after), 1).map((l) => (l ? `${l.kind[0]} ${l.text}` : '…'))).toEqual(['s 1', 'd 2', 'a two', 's 3', '…', 's 8', 'd 9', 'a nine'])
  })
})
