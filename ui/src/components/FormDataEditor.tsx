import { useRef, useState } from 'react'
import type { T } from '../lib/i18n'
import { hostFileTransfer, type BridgeFileHandle } from '../lib/bridge'
import { formatBytes } from '../lib/json'
import {
  describeFile,
  fileFor,
  forgetFile,
  isFileRow,
  rememberPicked,
  rowFiles,
  rowSizeOf,
} from '../lib/uploads'
import type { FileRef, FormField } from '../lib/types'

type Props = {
  t: T
  rows: FormField[]
  onChange: (rows: FormField[]) => void
  /**
   * False for urlencoded bodies, which cannot carry files: the type column goes
   * away and every row is text. Files a row still holds are left untouched and
   * called out, so switching encodings never destroys them.
   */
  allowFiles?: boolean
}

/** Drops every picked file a row holds, so none can be sent by a later request. */
function forgetRowFiles(row?: FormField): void {
  for (const ref of rowFiles(row ?? { key: '' })) forgetFile(ref.token)
  forgetFile(row?.file?.token)
}

/**
 * The form-data table: one row per field, each either text or a file.
 *
 * A file row points at picked Files through tokens held in the spec, so the row
 * survives re-renders and tab switches while the bytes stay in memory until the
 * request is sent — see lib/uploads for why a file cannot simply be a path. One
 * row may hold several files, and sends one part per file under its own key.
 *
 * The same table serves urlencoded bodies with allowFiles off. Rows keep their
 * files there instead of being flattened to text, so a body moved between the
 * two encodings and back arrives intact.
 */
export function FormDataEditor({ t, rows, onChange, allowFiles = true }: Props) {
  const update = (index: number, patch: Partial<FormField>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }
  const addRow = () =>
    onChange([...rows, { key: '', value: '', enabled: true, kind: 'text' }])
  const removeRow = (index: number) => {
    forgetRowFiles(rows[index])
    onChange(rows.filter((_, i) => i !== index))
  }

  /**
   * Adds files to a row, however they arrived. Picking or dropping more appends
   * rather than replaces, so a field can be filled from several folders without
   * having to select everything in one go; each file is removed on its own.
   * A File carries its bytes in this frame; a handle carries the host's —
   * rememberPicked mints the same kind of ref for both.
   */
  const attach = (index: number, added: Array<File | BridgeFileHandle>) => {
    const row = rows[index]
    if (!row || added.length === 0) return
    const files = [...rowFiles(row), ...added.map(rememberPicked)]
    update(index, { kind: 'file', value: undefined, file: undefined, files })
  }

  /** Removes one file from a row, leaving the rest of the field intact. */
  const removeFile = (index: number, fileIndex: number) => {
    const row = rows[index]
    if (!row) return
    const files = rowFiles(row)
    forgetFile(files[fileIndex]?.token)
    update(index, {
      files: files.filter((_, i) => i !== fileIndex),
      file: undefined,
    })
  }

  const setKind = (index: number, kind: 'text' | 'file') => {
    if (kind === 'text') {
      forgetRowFiles(rows[index])
      update(index, { kind, file: undefined, files: undefined })
      return
    }
    // The text the row held is dropped: a file row has no text value, and
    // leaving one behind would only be something to trip over later.
    forgetRowFiles(rows[index])
    update(index, { kind, value: undefined, file: undefined, files: undefined })
  }

  return (
    <div className={`kv-editor form-editor${allowFiles ? ' form-editor--files' : ''}`}>
      {!allowFiles && <UnsendableFiles t={t} rows={rows} />}
      <table>
        <thead>
          <tr>
            <th className="kv-on" aria-label="enabled" />
            <th>{t('key')}</th>
            {allowFiles && <th className="kv-kind">{t('bodyType')}</th>}
            <th>{t('value')}</th>
            <th className="kv-op" aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className="kv-on">
                <input
                  type="checkbox"
                  title={t('enableRow')}
                  aria-label={t('enableRow')}
                  checked={row.enabled !== false}
                  onChange={e => update(i, { enabled: e.target.checked })}
                />
              </td>
              <td>
                <input
                  className="dbx-input"
                  aria-label={t('key')}
                  value={row.key}
                  onChange={e => update(i, { key: e.target.value })}
                />
              </td>
              {allowFiles && (
                <td className="kv-kind">
                  <select
                    className="dbx-select kind-select"
                    aria-label={t('bodyType')}
                    value={row.kind === 'file' ? 'file' : 'text'}
                    onChange={e => setKind(i, e.target.value as 'text' | 'file')}
                  >
                    <option value="text">{t('fieldText')}</option>
                    <option value="file">{t('fieldFile')}</option>
                  </select>
                </td>
              )}
              <td>
                {allowFiles && isFileRow(row) ? (
                  <FileCell
                    t={t}
                    row={row}
                    onAttach={files => attach(i, files)}
                    onRemoveFile={fileIndex => removeFile(i, fileIndex)}
                  />
                ) : (
                  <ValueCell
                    t={t}
                    row={row}
                    allowFiles={allowFiles}
                    onChange={value => update(i, { value })}
                  />
                )}
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

/**
 * The value cell of a text row. Where files are not allowed, a row that still
 * holds some says so: those bytes will not travel with this encoding, and the
 * alternative — an input that looks like every other one — hides that until the
 * server receives nothing.
 */
function ValueCell({
  t,
  row,
  allowFiles,
  onChange,
}: {
  t: T
  row: FormField
  allowFiles: boolean
  onChange: (value: string) => void
}) {
  const files = allowFiles ? [] : rowFiles(row)
  return (
    <div className="value-cell">
      <input
        className="dbx-input"
        aria-label={t('value')}
        value={row.value ?? ''}
        onChange={e => onChange(e.target.value)}
      />
      {files.length > 0 && (
        <div className="file-note file-note--warn">{t('filesNotSentRow', { count: files.length })}</div>
      )}
    </div>
  )
}

/**
 * A banner over a urlencoded table that still holds files. The rows keep them so
 * nothing is lost, but they cannot go out in this encoding, and saying so here
 * is what keeps a send from failing with no warning.
 */
function UnsendableFiles({ t, rows }: { t: T; rows: FormField[] }) {
  const count = rows.reduce((sum, row) => sum + rowFiles(row).length, 0)
  if (count === 0) return null
  return (
    <div className="body-warning">
      {t('filesNotSentBanner', { count })}
    </div>
  )
}

/**
 * The value cell of a file row: one chip per file the row holds, plus a button
 * that adds more, or the picker button alone while the row is empty.
 *
 * Each row owns its own hidden input, so a choice is attributed by the DOM
 * rather than by remembering which button was pressed last.
 *
 * A file can also be dropped onto the cell. That route serves hosts without a
 * file bridge (the standalone dev host, a plain browser page). On the DBX
 * desktop workbench the OS drag never reaches this frame as HTML5 events —
 * the host intercepts it — so drops there arrive through the panel-level
 * fileTransfer.onDrop instead, and the picker rides the same bridge.
 *
 * A row saved from a cURL import carries a path instead of a picked file, and
 * the path is shown as-is — those requests keep sending without the user having
 * to pick anything. A row saved from a picked file has only its name left, so
 * it says outright that the file has to be chosen again rather than looking
 * ready to send.
 */
function FileCell({
  t,
  row,
  onAttach,
  onRemoveFile,
}: {
  t: T
  row: FormField
  onAttach: (files: Array<File | BridgeFileHandle>) => void
  onRemoveFile: (fileIndex: number) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const files = rowFiles(row)
  const size = rowSizeOf(files)

  /**
   * Opens the native picker through the host when it lends fileTransfer — the
   * sandboxed iframe cannot raise one itself — and falls back to a plain input
   * where it does not (the standalone dev host, a plain browser page).
   */
  const pick = () => {
    const transfer = hostFileTransfer()
    if (!transfer) {
      inputRef.current?.click()
      return
    }
    void transfer
      .pick({ multiple: true })
      .then(handles => {
        if (handles.length > 0) onAttach(handles)
      })
      .catch(() => undefined)
  }

  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!carriesFile(event)) return
      event.preventDefault()
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (event: React.DragEvent) => {
      const dropped = droppedFiles(event)
      setOver(false)
      if (dropped.length === 0) return
      event.preventDefault()
      onAttach(dropped)
    },
  }

  const picker = (
    <input
      ref={inputRef}
      type="file"
      multiple
      className="file-input"
      aria-hidden="true"
      tabIndex={-1}
      onChange={e => {
        const chosen = Array.from(e.target.files ?? [])
        // Reset so picking the same files twice in a row still fires.
        e.target.value = ''
        if (chosen.length > 0) onAttach(chosen)
      }}
    />
  )

  if (files.length === 0) {
    return (
      <>
        {picker}
        <button
          className={`ghost file-pick${over ? ' file-pick--over' : ''}`}
          title={t('chooseFileHint')}
          onClick={pick}
          {...dropProps}
        >
          {t('chooseFile')}
        </button>
      </>
    )
  }

  return (
    <>
      {picker}
      <div
        className={`file-cell file-cell--multi${over ? ' file-cell--over' : ''}`}
        {...dropProps}
      >
        <div className="file-chips">
          {files.map((ref, index) => (
            <FileChip
              t={t}
              key={ref.token || ref.path || index}
              file={ref}
              // Only a lone file has room for its size next to its name; with
              // several, the total goes on the line below.
              size={files.length === 1 ? size : undefined}
              onRemove={() => onRemoveFile(index)}
            />
          ))}
          <button
            className="ghost file-add"
            title={t('chooseFileHint')}
            aria-label={t('addFile')}
            onClick={pick}
          >
            +
          </button>
        </div>
        {files.length > 1 && (
          <div className="file-summary">
            {t('fileCount', { count: files.length })}
            {size !== undefined && ` · ${formatBytes(size)}`}
          </div>
        )}
      </div>
    </>
  )
}

/** One file inside a file row's cell, removable on its own. */
function FileChip({
  t,
  file,
  size,
  onRemove,
}: {
  t: T
  file: FileRef
  size?: number
  onRemove: () => void
}) {
  // A picked file's bytes are in memory; a path is resolved by the sidecar; a
  // name with neither is all that is left of a saved file.
  const state = fileFor(file.token) ? 'picked' : file.path ? 'path' : 'stale'
  return (
    <span className={`file-chip file-chip--${state}`} title={file.path || describeFile(file)}>
      <span className="file-chip-name">{describeFile(file)}</span>
      {size !== undefined && <span className="file-size">{formatBytes(size)}</span>}
      {state === 'path' && <span className="file-note">{t('fileFromPath')}</span>}
      {state === 'stale' && <span className="file-note file-note--warn">{t('fileNeedsPick')}</span>}
      <button
        className="ghost file-chip-x"
        title={t('clearFile')}
        aria-label={t('clearFile')}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  )
}

/** True when a drag is carrying files, rather than text or a selection. */
function carriesFile(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

/** The files a drop carried, which may be several. */
function droppedFiles(event: React.DragEvent): File[] {
  return Array.from(event.dataTransfer?.files ?? [])
}
