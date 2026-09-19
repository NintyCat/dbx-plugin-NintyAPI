import type { CollectionNode, KV } from './types'

/**
 * Reserved virtual parent for quick-saved requests. Nodes with this parentId
 * live outside the folder tree and render under the 快捷请求 group. Must match
 * store.QuickRootID in the backend.
 */
export const QUICK_ROOT_ID = '__quick__'

export type TreeNode = CollectionNode & { children: TreeNode[] }

/** Build the folder tree from the flat node list; orphans surface at root. */
export function buildTree(nodes: CollectionNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const node of nodes) byId.set(node.id, { ...node, children: [] })
  const roots: TreeNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent && parent.type === 'folder' && parent.id !== node.id) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortRec = (list: TreeNode[]) => {
    // Folders always render ahead of requests — a drop can never reorder a
    // request above one. Within each kind, drag order wins, and nodes never
    // explicitly ordered (order 0) fall back to by-name before ordered ones.
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      const byOrder = (a.order ?? 0) - (b.order ?? 0)
      if (byOrder !== 0) return byOrder
      return a.name.localeCompare(b.name)
    })
    for (const item of list) sortRec(item.children)
  }
  sortRec(roots)
  return roots
}

/** Split a URL into base and query params for the Params tab. */
export function splitUrlQuery(
  url: string
): { base: string; params: KV[] } {
  const index = url.indexOf('?')
  if (index < 0) return { base: url, params: [] }
  const base = url.slice(0, index)
  const params: KV[] = []
  for (const pair of url.slice(index + 1).split('&')) {
    if (!pair) continue
    const [key, value = ''] = pair.split('=')
    params.push({
      key: decodeURIComponent(key),
      value: decodeURIComponent(value),
      enabled: true,
    })
  }
  return { base, params }
}

/** Join base and enabled params back into a URL. */
export function joinUrlQuery(base: string, params: KV[]): string {
  const query = (params || [])
    .filter(p => p.enabled !== false && p.key)
    .map(
      p =>
        `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`
    )
    .join('&')
  if (!query) return base
  return `${base}${base.includes('?') ? '&' : '?'}${query}`
}

/** Merge enabled params into an editable spec URL right before sending. */
export function effectiveUrl(spec: {
  url: string
  queryParams?: KV[]
}): string {
  return joinUrlQuery(spec.url, spec.queryParams || [])
}
