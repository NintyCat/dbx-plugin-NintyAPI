import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DictKey, T } from '../lib/i18n'
import { formatBytes, highlightJson } from '../lib/json'
import { highlightMarkup, tryFormatMarkup } from '../lib/markup'
import { splitUrlQuery } from '../lib/tree'
import { hostFileTransfer, type BridgeFileHandle } from '../lib/bridge'
import {
  describeFile,
  fileFor,
  fileSizeOf,
  forgetFile,
  rememberPicked,
  rowFiles,
} from '../lib/uploads'
import type { BodySpec, KV, RequestSpec } from '../lib/types'
import { METHODS } from '../lib/types'
import { Icon } from './Icon'
import { Select } from './Select'
import { KVEditor } from './KVEditor'
import { FormDataEditor } from './FormDataEditor'

export type EditorTab = 'params' | 'headers' | 'body' | 'auth' | 'settings'

type Props = {
  t: T
  spec: RequestSpec
  onChange: (spec: RequestSpec) => void
  onSend: () => void
  onSave: () => void
  onSaveAs: () => void
  onImportCurl: () => void
  onGenerateCode: () => void
  onEnvConfig: () => void
  /** Name of the environment requests resolve against; empty when none. */
  activeEnvName?: string
  sending: boolean
  /** Percent of the request's files uploaded, while they are still going. */
  uploadPercent?: number
  dirty: boolean
  /** False when a direct save is impossible, e.g. a new request with no URL. */
  canSave?: boolean
  /** Bumped when an import brought a body: open the body tab on it. */
  revealBody?: number
  /** One-line notices: a drop that the current body cannot carry, and such. */
  onNotice?: (message: string) => void
}

const BODY_TYPES = ['none', 'json', 'xml', 'raw', 'form', 'multipart', 'binary'] as const

const BODY_LABELS: Record<(typeof BODY_TYPES)[number], DictKey> = {
  none: 'none',
  json: 'json',
  xml: 'xml',
  raw: 'rawBody',
  form: 'form',
  multipart: 'multipart',
  binary: 'binary',
}

/**
 * The Content-Type each body type sends when the editor leaves it alone, shown
 * on the chip. The labels are protocol names, so the media type behind each one
 * is the only thing that makes them unambiguous — and the two form encodings
 * differ in nothing else. A typed Content-Type header still wins, except for
 * multipart, whose boundary only the sender knows.
 */
const BODY_CONTENT_TYPES: Partial<Record<(typeof BODY_TYPES)[number], string>> = {
  json: 'application/json',
  xml: 'application/xml',
  raw: 'text/plain',
  form: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
  binary: 'application/octet-stream',
}

export function RequestPanel(props: Props) {
  const { t, spec, sending, dirty, canSave = true, revealBody, uploadPercent } = props
  const [tab, setTab] = useState<EditorTab>(revealBody ? 'body' : 'params')
  // A later import into this same request bumps revealBody; the tab follows so
  // the imported payload shows up in the editor that matches its type.
  const revealed = useRef(revealBody)
  useEffect(() => {
    if (revealBody === undefined || revealBody === revealed.current) return
    revealed.current = revealBody
    setTab('body')
  }, [revealBody])
  // The URL input shows base+query joined; the Params tab edits the split.
  const urlWithQuery = useMemo(() => {
    const query = (spec.queryParams || [])
      .filter(p => p.enabled !== false && p.key)
      .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
      .join('&')
    return query
      ? `${spec.url}${spec.url.includes('?') ? '&' : '?'}${query}`
      : spec.url
  }, [spec.url, spec.queryParams])

  const commitUrl = (value: string) => {
    const { base, params } = splitUrlQuery(value)
    props.onChange({
      ...spec,
      url: base,
      queryParams: params.length
        ? mergeParams(spec.queryParams || [], params)
        : spec.queryParams,
    })
  }

  // --- OS file drops from the host bridge (DBX desktop workbench) ----------
  // The host intercepts an OS drag before any HTML5 event exists, so a drop
  // onto this workbench arrives through fileTransfer.onDrop with no cursor
  // position — the panel, not a cell, is what routes it. The newest spec and
  // callbacks live in refs so the subscriptions can be installed once.
  const [hostDrag, setHostDrag] = useState(false)
  const specRef = useRef(spec)
  specRef.current = spec
  const applyRef = useRef(props.onChange)
  applyRef.current = props.onChange
  const noticeRef = useRef(props.onNotice)
  noticeRef.current = props.onNotice

  useEffect(() => {
    const transfer = hostFileTransfer()
    if (!transfer) return
    const offDrag = transfer.onDragState(active =>
      setHostDrag(active && bodyCanCarryFiles(specRef.current.body))
    )
    const offDrop = transfer.onDrop(files => {
      setHostDrag(false)
      if (files.length === 0) return
      const current = specRef.current
      const body = current.body || { type: 'none' as const }
      const refs = files.map(rememberPicked)
      if (body.type === 'none') {
        // An empty body switching to form-data loses nothing, and the rows
        // show up exactly where the user dropped the files.
        applyRef.current({
          ...current,
          body: { type: 'multipart', fields: [{ key: '', enabled: true, kind: 'file', files: refs }] },
        })
        setTab('body')
        return
      }
      if (body.type === 'multipart') {
        const fields = [...(body.fields || [])]
        const target = fields.findIndex(f => f.enabled !== false && f.kind === 'file')
        if (target >= 0) {
          fields[target] = {
            ...fields[target],
            kind: 'file',
            value: undefined,
            file: undefined,
            files: [...rowFiles(fields[target]), ...refs],
          }
        } else {
          fields.push({ key: '', enabled: true, kind: 'file', files: refs })
        }
        applyRef.current({ ...current, body: { ...body, fields } })
        setTab('body')
        return
      }
      if (body.type === 'binary') {
        forgetFile(body.file?.token)
        if (files.length > 1) noticeRef.current?.(t('dropBinaryFirst', { name: files[0].name }))
        applyRef.current({ ...current, body: { ...body, file: refs[0] } })
        setTab('body')
        return
      }
      noticeRef.current?.(t('dropUnsupportedBody'))
    })
    return () => {
      offDrag()
      offDrop()
    }
  }, [t])

  const rows = (list?: KV[]) => list || []
  const body = spec.body || { type: 'none' as const }
  const auth = spec.auth || { type: 'none' as const }
  const methodClass = `m-${(spec.method || 'GET').toLowerCase()}`

  const formatBody = () => {
    if (!body.content) return
    if (body.type === 'json') {
      try {
        props.onChange({
          ...spec,
          body: { ...body, content: JSON.stringify(JSON.parse(body.content), null, 2) },
        })
      } catch {
        /* invalid JSON: leave as-is */
      }
    } else if (body.type === 'xml') {
      const { pretty, ok } = tryFormatMarkup(body.content)
      if (ok) props.onChange({ ...spec, body: { ...body, content: pretty } })
    }
  }

  return (
    <section className="req">
      <div className="req-line">
        <Select
          className={`method-select ${methodClass}`}
          aria-label={t('method')}
          value={spec.method || 'GET'}
          options={METHODS.map(m => ({
            value: m,
            label: m,
            className: `m-${m.toLowerCase()}`,
          }))}
          onChange={method => props.onChange({ ...spec, method })}
        />
        <input
          className="dbx-input url-input"
          aria-label={t('url')}
          placeholder="https://api.example.com/users/{{id}}"
          value={urlWithQuery}
          onChange={e => commitUrl(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !sending) props.onSend()
          }}
        />
        <button className="send" disabled={sending} onClick={props.onSend}>
          <Icon name="send" size={14} />
          {uploadPercent !== undefined
            ? t('uploading', { percent: uploadPercent })
            : sending
              ? t('sending')
              : t('send')}
        </button>
        <button
          className={`ghost req-tool ${dirty ? 'dirty' : ''}`}
          title={canSave ? t('save') : t('urlRequired')}
          disabled={!canSave}
          onClick={props.onSave}
        >
          <Icon name="save" size={14} />
          {t('save')}
        </button>
        <button className="ghost req-tool" title={t('saveAs')} onClick={props.onSaveAs}>
          <Icon name="folder" size={14} />
          {t('saveAs')}
        </button>
      </div>
      <div className="req-tabs">
        {(
          [
            ['params', `${t('params')} ${count(spec.queryParams)}`],
            ['headers', `${t('headers')} ${count(spec.headers)}`],
            ['body', t('body')],
            ['auth', t('auth')],
            ['settings', t('settings')],
          ] as Array<[EditorTab, string]>
        ).map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        <span className="spacer" />
        <button className="ghost tab-tool" onClick={props.onImportCurl}>
          <Icon name="import" size={13} /> {t('importCurl')}
        </button>
        <button className="ghost tab-tool" onClick={props.onGenerateCode}>
          <Icon name="code" size={13} /> {t('generateCode')}
        </button>
        <button
          className="ghost tab-tool"
          onClick={props.onEnvConfig}
          title={
            props.activeEnvName
              ? `${t('environmentConfig')} · ${t('environment')}: ${props.activeEnvName}`
              : t('environmentConfig')
          }
        >
          <Icon name="globe" size={13} /> {props.activeEnvName || t('environmentConfig')}
        </button>
      </div>
      <div className="req-body">
        {tab === 'params' && (
          <KVEditor
            t={t}
            rows={rows(spec.queryParams)}
            onChange={r => props.onChange({ ...spec, queryParams: r })}
          />
        )}
        {tab === 'headers' && (
          <KVEditor
            t={t}
            rows={rows(spec.headers)}
            onChange={r => props.onChange({ ...spec, headers: r })}
          />
        )}
        {tab === 'body' && (
          <div className="body-editor">
            <div className="body-types">
              {BODY_TYPES.map(type => (
                <button
                  key={type}
                  className={body.type === type ? 'chip active' : 'chip'}
                  title={BODY_CONTENT_TYPES[type]}
                  onClick={() => props.onChange({ ...spec, body: { ...body, type } })}
                >
                  {t(BODY_LABELS[type])}
                </button>
              ))}
              <span className="spacer" />
              {(body.type === 'json' || body.type === 'xml') && body.content && (
                <button className="ghost sm" onClick={formatBody} title={t('format')}>
                  <Icon name="format" size={13} /> {t('format')}
                </button>
              )}
            </div>
            {body.type === 'form' && (
              /* The same table as form-data, with files switched off: rows keep
                 whatever files they hold, so moving between the two encodings
                 never flattens a file row into an empty text one. */
              <FormDataEditor
                t={t}
                rows={body.fields || []}
                allowFiles={false}
                onChange={fields => props.onChange({ ...spec, body: { ...body, fields } })}
              />
            )}
            {body.type === 'multipart' && (
              <FormDataEditor
                t={t}
                rows={body.fields || []}
                onChange={fields => props.onChange({ ...spec, body: { ...body, fields } })}
              />
            )}
            {body.type === 'none' && (
              <div className="body-placeholder">{props.t('noBody')}</div>
            )}
            {(body.type === 'json' || body.type === 'xml' || body.type === 'raw') && (
              /* Every text body type shares the JSON editor so they all look and
                 behave the same; only the highlighter differs. */
              <HighlightedCode
                value={body.content || ''}
                highlight={
                  body.type === 'json'
                    ? highlightJson
                    : body.type === 'xml'
                      ? highlightMarkup
                      : undefined
                }
                onChange={content =>
                  props.onChange({ ...spec, body: { ...body, content } })
                }
              />
            )}
            {body.type === 'binary' && (
              <BinaryBody
                t={t}
                body={body}
                onChange={next => props.onChange({ ...spec, body: next })}
              />
            )}
          </div>
        )}
        {tab === 'auth' && (
          <div className="auth-editor">
            <div className="body-types">
              {(['none', 'bearer', 'basic'] as const).map(type => (
                <button
                  key={type}
                  className={auth.type === type ? 'chip active' : 'chip'}
                  onClick={() => props.onChange({ ...spec, auth: { ...auth, type } })}
                >
                  {t(type === 'bearer' ? 'bearer' : type === 'basic' ? 'basic' : 'none')}
                </button>
              ))}
            </div>
            {auth.type === 'bearer' && (
              <label className="field">
                <span>{t('token')}</span>
                <input className="dbx-input"
                  value={auth.token || ''}
                  onChange={e => props.onChange({ ...spec, auth: { ...auth, token: e.target.value } })}
                />
              </label>
            )}
            {auth.type === 'basic' && (
              <>
                <label className="field">
                  <span>{t('username')}</span>
                  <input className="dbx-input"
                    value={auth.username || ''}
                    onChange={e =>
                      props.onChange({ ...spec, auth: { ...auth, username: e.target.value } })
                    }
                  />
                </label>
                <label className="field">
                  <span>{t('password')}</span>
                  <input className="dbx-input"
                    type="password"
                    value={auth.password || ''}
                    onChange={e =>
                      props.onChange({ ...spec, auth: { ...auth, password: e.target.value } })
                    }
                  />
                </label>
              </>
            )}
          </div>
        )}
        {tab === 'settings' && (
          <div className="settings-editor">
            <label className="check">
              <input
                type="checkbox"
                checked={spec.settings?.followRedirects !== false}
                onChange={e =>
                  props.onChange({
                    ...spec,
                    settings: { ...spec.settings, followRedirects: e.target.checked },
                  })
                }
              />
              {t('followRedirects')}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={spec.settings?.verifyTLS !== false}
                onChange={e =>
                  props.onChange({
                    ...spec,
                    settings: { ...spec.settings, verifyTLS: e.target.checked },
                  })
                }
              />
              {t('verifyTLS')}
            </label>
            <label className="field narrow">
              <span>{t('timeout')}</span>
              <input className="dbx-input"
                type="number"
                min={1}
                max={300000}
                value={spec.settings?.timeoutMs ?? ''}
                placeholder="30000"
                onChange={e =>
                  props.onChange({
                    ...spec,
                    settings: {
                      ...spec.settings,
                      timeoutMs: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
              />
            </label>
          </div>
        )}
      </div>
      {hostDrag && (
        <div className="drop-veil" aria-hidden="true">
          <span>{t('dropToAttach')}</span>
        </div>
      )}
    </section>
  )
}

/** True when a drop can be attached without throwing anything away. */
function bodyCanCarryFiles(body: BodySpec | undefined): boolean {
  return !body || body.type === 'none' || body.type === 'multipart' || body.type === 'binary'
}

function count(list?: KV[]): string {
  const n = (list || []).filter(r => r.enabled !== false && r.key).length
  return n ? `· ${n}` : ''
}

/**
 * The binary body: a picked file when there is one, otherwise a path typed by
 * hand. Picking wins when both are present, because those bytes are known to be
 * reachable while a path only means something on the machine running DBX.
 */
function BinaryBody({
  t,
  body,
  onChange,
}: {
  t: T
  body: BodySpec
  onChange: (body: BodySpec) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const ref = body.file
  const picked = fileFor(ref?.token)
  const label = describeFile(ref)
  const size = fileSizeOf(ref)
  // Requests saved before file picking put the path in Content; showing it here
  // keeps those bodies editable, and the first keystroke migrates it.
  const path = ref?.path ?? body.content ?? ''

  const choose = (entry?: File | BridgeFileHandle) => {
    if (!entry) return
    forgetFile(ref?.token)
    onChange({
      ...body,
      file: rememberPicked(entry),
    })
  }

  // A drop needs no permission, so it is the route that still works if the
  // host's sandbox refuses to open a native picker. On the DBX desktop
  // workbench the native picker runs through the host's fileTransfer instead,
  // and drops arrive at panel level — see RequestPanel's onDrop.
  const pick = () => {
    const transfer = hostFileTransfer()
    if (!transfer) {
      inputRef.current?.click()
      return
    }
    void transfer
      .pick({ multiple: false })
      .then(handles => choose(handles[0]))
      .catch(() => undefined)
  }

  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
      event.preventDefault()
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (event: React.DragEvent) => {
      const file = event.dataTransfer?.files?.[0]
      setOver(false)
      if (!file) return
      event.preventDefault()
      choose(file)
    },
  }

  return (
    <div className="binary-body">
      <input
        ref={inputRef}
        type="file"
        className="file-input"
        aria-hidden="true"
        tabIndex={-1}
        onChange={e => {
          choose(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {label ? (
        <div
          className={`file-cell${picked ? '' : ' file-cell--path'}${over ? ' file-cell--over' : ''}`}
          {...dropProps}
        >
          <button
            className="ghost file-name"
            title={picked ? t('chooseFileHint') : label}
            onClick={pick}
          >
            {label}
          </button>
          {size !== undefined && <span className="file-size">{formatBytes(size)}</span>}
          {!picked && (
            <span className={`file-note${path ? '' : ' file-note--warn'}`}>
              {path ? t('fileFromPath') : t('fileNeedsPick')}
            </span>
          )}
          <button
            className="ghost file-clear"
            title={t('clearFile')}
            aria-label={t('clearFile')}
            onClick={() => {
              forgetFile(ref?.token)
              onChange({ ...body, file: undefined })
            }}
          >
            ×
          </button>
        </div>
      ) : (
        <button
          className={`ghost file-pick${over ? ' file-pick--over' : ''}`}
          title={t('chooseFileHint')}
          onClick={pick}
          {...dropProps}
        >
          <Icon name="folder" size={13} /> {t('chooseFile')}
        </button>
      )}
      {/* A path is the only route for a file the browser cannot read, so the
          editor keeps offering it even after a file has been picked. */}
      <label className="field">
        <span>{t('binaryPath')}</span>
        <input
          className="dbx-input"
          placeholder="/absolute/path/to/file"
          value={path}
          onChange={e =>
            onChange({
              ...body,
              content: undefined,
              file: { ...ref, path: e.target.value || undefined },
            })
          }
        />
      </label>
      <div className="dbx-hint">{t('binaryHint')}</div>
    </div>
  )
}

function mergeParams(current: KV[], parsed: KV[]): KV[] {
  // Parsed-from-URL rows replace the enabled set; disabled rows are kept.
  const disabled = current.filter(p => p.enabled === false)
  return [...parsed, ...disabled]
}

/**
 * Transparent textarea layered over a syntax-highlighted pre block. The two
 * share identical typography so caret and text land on the same glyphs. The
 * highlighter is optional: without one the text renders as-is, which is what
 * the plain-text body wants.
 */
function HighlightedCode({
  value,
  onChange,
  highlight,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  highlight?: (text: string) => ReactNode
  placeholder?: string
}) {
  const preRef = useRef<HTMLPreElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const highlighted = useMemo(
    () => (highlight ? highlight(value) : [value]),
    [value, highlight],
  )
  const syncScroll = () => {
    if (preRef.current && textRef.current) {
      preRef.current.scrollTop = textRef.current.scrollTop
      preRef.current.scrollLeft = textRef.current.scrollLeft
    }
  }
  return (
    <div className="code-editor">
      <pre ref={preRef} aria-hidden="true">
        {highlighted}
        {'\n'}
      </pre>
      <textarea
        ref={textRef}
        className="code-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={e => onChange(e.target.value)}
        onScroll={syncScroll}
      />
    </div>
  )
}
