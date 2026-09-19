import { useState } from 'react'
import type { T } from '../lib/i18n'
import { Select } from './Select'

export type FolderOption = { id: string; name: string; depth: number }

/**
 * "Save as API" dialog: pick a destination folder inside the default module
 * and confirm a name. Saving into the quick-request group bypasses this
 * dialog entirely.
 */
export function SaveAsDialog({
  t,
  title,
  initialName,
  folders,
  submitText,
  onSubmit,
  onClose,
}: {
  t: T
  title: string
  initialName: string
  folders: FolderOption[]
  submitText: string
  onSubmit: (name: string, parentId: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(initialName)
  const [parentId, setParentId] = useState('')
  const submit = () => {
    if (!name.trim()) return
    onSubmit(name.trim(), parentId)
    onClose()
  }
  return (
    <div className="dlg-backdrop" onClick={onClose}>
      <div
        className="dlg"
        role="dialog"
        aria-label={title}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'SELECT') submit()
          if (e.key === 'Escape') onClose()
        }}
      >
        <h3>{title}</h3>
        <label className="dlg-field">
          <span>{t('nameLabel')}</span>
          <input className="dbx-input" autoFocus value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="dlg-field">
          <span>{t('folderLabel')}</span>
          <Select
            aria-label={t('folderLabel')}
            value={parentId}
            options={[
              { value: '', label: t('rootFolder') },
              ...folders.map(f => ({
                value: f.id,
                label: '\u00A0'.repeat(f.depth * 4) + f.name,
              })),
            ]}
            onChange={setParentId}
          />
        </label>
        <div className="dlg-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={!name.trim()} onClick={submit}>
            {submitText}
          </button>
        </div>
      </div>
    </div>
  )
}
