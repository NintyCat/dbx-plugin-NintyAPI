import { describe, expect, it } from 'vitest'
import { buildTree, type TreeNode } from './tree'
import type { CollectionNode } from './types'

const node = (over: Partial<CollectionNode>): CollectionNode => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  type: 'request',
  name: 'node',
  createdAt: '',
  updatedAt: '',
  ...over,
})

const names = (list: TreeNode[]) => list.map(n => n.name)

describe('buildTree', () => {
  it('sorts siblings by explicit drag order', () => {
    const tree = buildTree([
      node({ id: 'a', name: '甲', order: 2 }),
      node({ id: 'b', name: '乙', order: 1 }),
      node({ id: 'c', name: '丙' }),
    ])
    // Unordered nodes keep their folders-first, by-name place before ordered ones.
    expect(names(tree)).toEqual(['丙', '乙', '甲'])
  })

  it('respects drag order inside nested folders', () => {
    const tree = buildTree([
      node({ id: 'f', type: 'folder', name: '目录' }),
      node({ id: 'x', name: '新在后', parentId: 'f', order: 2 }),
      node({ id: 'y', name: '拖到前', parentId: 'f', order: 1 }),
    ])
    expect(names(tree[0].children)).toEqual(['拖到前', '新在后'])
  })

  it('breaks ties by folders first, then name', () => {
    const tree = buildTree([
      node({ id: '1', name: 'b 请求' }),
      node({ id: '2', type: 'folder', name: 'a 目录' }),
      node({ id: '3', name: 'a 请求' }),
    ])
    expect(names(tree)).toEqual(['a 目录', 'a 请求', 'b 请求'])
  })

  it('keeps folders ahead of requests however their orders compare', () => {
    const tree = buildTree([
      node({ id: 'r', name: '请求', order: 1 }),
      node({ id: 'f', type: 'folder', name: '目录', order: 2 }),
    ])
    expect(names(tree)).toEqual(['目录', '请求'])
  })
})
