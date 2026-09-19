import { useState, type KeyboardEvent } from 'react'

type PromptState = {
  title: string
  initial: string
  /** Row label for the input, matching the auth tab's field rows. */
  label?: string
  placeholder?: string
  multiline?: boolean
  danger?: boolean
  confirmText?: string
  /** Confirmation-only dialog: no text input, the action needs no value. */
  confirmOnly?: boolean
  onSubmit: (value: string) => void
}

export function useDialogState() {
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const askText = (
    title: string,
    initial: string,
    onSubmit: (value: string) => void,
    options?: { label?: string; placeholder?: string; multiline?: boolean }
  ) => setPrompt({ title, initial, onSubmit, ...options })
  const askConfirm = (
    title: string,
    onSubmit: () => void,
    danger = true
  ) =>
    setPrompt({
      title,
      initial: '',
      onSubmit,
      danger,
      confirmOnly: true,
      confirmText: '确定',
    })
  const close = () => setPrompt(null)
  return { prompt, askText, askConfirm, close }
}

export function Dialog({
  prompt,
  onClose,
}: {
  prompt: PromptState
  onClose: () => void
}) {
  const [value, setValue] = useState(prompt.initial)
  const submit = () => {
    prompt.onSubmit(value)
    onClose()
  }
  // Confirmation-only dialogs have nothing to type; keep Esc/Enter working
  // without parking focus in an empty field.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (!prompt.multiline || e.metaKey || e.ctrlKey)) submit()
    if (e.key === 'Escape') onClose()
  }
  return (
    <div className="dlg-backdrop" onClick={onClose}>
      <div
        className="dlg"
        role="dialog"
        aria-label={prompt.title}
        onClick={e => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h3 className={prompt.danger ? 'danger' : ''}>{prompt.title}</h3>
        {prompt.confirmOnly ? null : (
          <label className={prompt.multiline ? 'field multi' : 'field'}>
            {prompt.label && <span>{prompt.label}</span>}
            {prompt.multiline ? (
              <textarea className="dbx-textarea"
                autoFocus
                value={value}
                placeholder={prompt.placeholder}
                rows={6}
                onChange={e => setValue(e.target.value)}
              />
            ) : (
              <input className="dbx-input"
                autoFocus
                value={value}
                placeholder={prompt.placeholder}
                onChange={e => setValue(e.target.value)}
              />
            )}
          </label>
        )}
        <div className="dlg-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            autoFocus={prompt.confirmOnly}
            className={prompt.danger ? 'danger' : 'primary'}
            onClick={submit}
          >
            {prompt.confirmText || '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}

export type { PromptState }
