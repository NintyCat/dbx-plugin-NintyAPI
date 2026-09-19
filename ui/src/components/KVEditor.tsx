import type { T } from '../lib/i18n'
import type { KV } from '../lib/types'

type Props = {
  t: T
  rows: KV[]
  onChange: (rows: KV[]) => void
  fileHint?: boolean
}

export function KVEditor({ t, rows, onChange }: Props) {
  const update = (index: number, patch: Partial<KV>) => {
    const next = rows.map((row, i) =>
      i === index ? { ...row, ...patch } : row
    )
    onChange(next)
  }
  const addRow = () => onChange([...rows, { key: '', value: '', enabled: true }])
  const removeRow = (index: number) =>
    onChange(rows.filter((_, i) => i !== index))
  const list = rows.length ? rows : []
  return (
    <div className="kv-editor">
      <table>
        <thead>
          <tr>
            <th className="kv-on" aria-label="enabled" />
            <th>{t('key')}</th>
            <th>{t('value')}</th>
            <th className="kv-op" aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {list.map((row, i) => (
            <tr key={i}>
              <td className="kv-on">
                <input
                  type="checkbox"
                  title={t('enableRow')}
                  aria-label={t('enableRow')}
                  checked={row.enabled !== false}
                  onChange={e =>
                    update(i, { enabled: e.target.checked })
                  }
                />
              </td>
              <td>
                <input className="dbx-input" value={row.key} onChange={e => update(i, { key: e.target.value })} />
              </td>
              <td>
                <input className="dbx-input" value={row.value} onChange={e => update(i, { value: e.target.value })} />
              </td>
              <td className="kv-op">
                <button
                  className="ghost"
                  title={t('removeRow')}
                  aria-label={t('removeRow')}
                  onClick={() => removeRow(i)}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="ghost kv-add" onClick={addRow}>
        + {t('addKeyValue')}
      </button>
    </div>
  )
}
