import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DictKey, T } from '../lib/i18n'
import { highlightJson } from '../lib/json'
import { highlightMarkup, tryFormatMarkup } from '../lib/markup'
import { splitUrlQuery } from '../lib/tree'
import type { KV, RequestSpec } from '../lib/types'
import { METHODS } from '../lib/types'
import { Icon } from './Icon'
import { Select } from './Select'
import { KVEditor } from './KVEditor'

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
  dirty: boolean
  /** False when a direct save is impossible, e.g. a new request with no URL. */
  canSave?: boolean
  /** Bumped when an import brought a body: open the body tab on it. */
  revealBody?: number
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

export function RequestPanel(props: Props) {
  const { t, spec, sending, dirty, canSave = true, revealBody } = props
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
          {sending ? t('sending') : t('send')}
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
            {(body.type === 'form' || body.type === 'multipart') && (
              <KVEditor
                t={t}
                rows={rows(body.fields)}
                fileHint={body.type === 'multipart'}
                onChange={r => props.onChange({ ...spec, body: { ...body, fields: r } })}
              />
            )}
            {body.type === 'none' && (
              <div className="body-placeholder">{props.t('noBody')}</div>
            )}
            {(body.type === 'json' ||
              body.type === 'xml' ||
              body.type === 'raw' ||
              body.type === 'binary') && (
              /* Every body type shares the JSON editor so they all look and
                 behave the same; only the highlighter and hint differ. */
              <HighlightedCode
                value={body.content || ''}
                highlight={
                  body.type === 'json'
                    ? highlightJson
                    : body.type === 'xml'
                      ? highlightMarkup
                      : undefined
                }
                placeholder={body.type === 'binary' ? '/absolute/path/to/file' : undefined}
                onChange={content =>
                  props.onChange({ ...spec, body: { ...body, content } })
                }
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
    </section>
  )
}

function count(list?: KV[]): string {
  const n = (list || []).filter(r => r.enabled !== false && r.key).length
  return n ? `· ${n}` : ''
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
