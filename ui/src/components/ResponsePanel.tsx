import { useState } from 'react'
import { copyText } from '../lib/clipboard'
import type { T } from '../lib/i18n'
import { formatBytes, highlightJson, tryPretty } from '../lib/json'
import { highlightMarkup, tryFormatMarkup } from '../lib/markup'
import type { Response } from '../lib/types'
import { Icon } from './Icon'

type Props = {
  t: T
  response: Response | null
  sending: boolean
  /** This response is a history replay whose body was cut to fit the file. */
  bodyOmitted?: boolean
  /** True while the pane is reduced to its status line. */
  collapsed?: boolean
  onToggleCollapse?: () => void
  /** Empties the connection's cookie store; the tab says when it happened. */
  onClearCookies?: () => void
}

type ViewTab = 'pretty' | 'raw' | 'headers' | 'cookies'

const statusClass = (status: number) =>
  status === 0 ? 'bad' : status >= 500 ? 'bad' : status >= 400 ? 'warn' : 'ok'

export function ResponsePanel({
  t,
  response,
  sending,
  bodyOmitted,
  collapsed,
  onToggleCollapse,
  onClearCookies,
}: Props) {
  const [tab, setTab] = useState<ViewTab>('pretty')
  const [wrap, setWrap] = useState(true)
  const [copied, setCopied] = useState(false)
  // Collapsing keeps the status row; the way back from it sits at its right.
  const rootClass = collapsed ? 'resp collapsed' : 'resp'
  const collapseToggle = onToggleCollapse && (
    <button
      className="icon-btn framed"
      title={collapsed ? t('expandResponse') : t('collapseResponse')}
      aria-pressed={collapsed}
      onClick={onToggleCollapse}
    >
      <Icon name={collapsed ? 'chevron-up' : 'chevron-down'} />
    </button>
  )
  if (sending)
    return (
      <section className={rootClass}>
        <div className="resp-empty">{t('sending')}</div>
      </section>
    )
  if (!response)
    return (
      <section className={rootClass}>
        <div className="resp-empty">{t('emptyResponse')}</div>
      </section>
    )
  const copyBody = () => {
    void copyText(response.body).then(ok => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  if (response.error)
    return (
      <section className={rootClass}>
        <div className="resp-head">
          <span className={`status pill bad`}>{t('networkError')}</span>
          <span className="meta">{response.timeMs} ms</span>
          <span className="spacer" />
          {collapseToggle}
        </div>
        <pre className="resp-error">{response.error}</pre>
      </section>
    )
  const cookies = response.cookies ?? []
  // The pretty tab renders whatever the body turns out to be. Both formats are
  // detected from the bytes, never from the Content-Type: servers label
  // responses badly, and the one that started this was a page served as
  // application/x-gzip.
  const viewed = tab === 'pretty' && !response.bodyBinary ? response.body : null
  const json = viewed !== null ? tryPretty(viewed) : null
  const markup = viewed !== null && !json?.ok ? tryFormatMarkup(viewed) : null
  const bodyView =
    response.bodyBinary ? (
      <pre className={wrap ? 'wrap' : ''}>
        {t('binaryBody', { size: formatBytes(response.sizeBytes) })}
        {'\n'}
        {response.body.slice(0, 2000)}
      </pre>
    ) : json?.ok ? (
      <pre className={wrap ? 'wrap' : ''}>{highlightJson(json.pretty)}</pre>
    ) : markup?.ok ? (
      <pre className={wrap ? 'wrap' : ''}>{highlightMarkup(markup.pretty)}</pre>
    ) : (
      <pre className={wrap ? 'wrap' : ''}>{response.body}</pre>
    )
  return (
    <section className={rootClass}>
      <div className="resp-head">
        <span className={`status pill ${statusClass(response.status)}`}>
          {response.status} {response.statusText}
        </span>
        <span className="meta">{response.timeMs} ms</span>
        <span className="meta">{formatBytes(response.sizeBytes)}</span>
        {response.proto && <span className="meta">{response.proto}</span>}
        {/* The live cap and the history file's cap mean the same thing here:
            what is on screen is shorter than what the server sent. */}
        {bodyOmitted ? (
          <span className="meta warn">{t('historyBodyTruncated')}</span>
        ) : (
          response.truncated && <span className="meta warn">{t('truncated')}</span>
        )}
        <span className="spacer" />
        <button className="icon-btn framed" title={t('copyResponse')} onClick={copyBody}>
          <Icon name={copied ? 'check' : 'copy'} />
        </button>
        {/* Wrapping only shows on lines wider than the pane, so the button
            carries the state itself: pressed means long lines are wrapped. */}
        <button
          className={wrap ? 'icon-btn framed active' : 'icon-btn framed'}
          title={wrap ? t('noWrap') : t('wrapLines')}
          aria-pressed={wrap}
          onClick={() => setWrap(w => !w)}
        >
          <Icon name="format" />
        </button>
        {collapseToggle}
      </div>
      {response.timing &&
        (response.timing.dnsMs > 0 ||
          response.timing.connectMs > 0 ||
          response.timing.tlsMs > 0) && (
          <div className="resp-timing">
            <span>DNS {response.timing.dnsMs}ms</span>
            <span>TCP {response.timing.connectMs}ms</span>
            <span>TLS {response.timing.tlsMs}ms</span>
            <span>TTFB {response.timing.firstByteMs}ms</span>
          </div>
        )}
      {response.redirects && response.redirects.length > 0 && (
        <div className="resp-redirects">
          {response.redirects.map((r, i) => (
            <span key={i} className="meta">
              {r.status} → {r.location}
            </span>
          ))}
        </div>
      )}
      <div className="resp-tabs">
        {(
          [
            ['pretty', t('pretty')],
            ['raw', t('raw')],
            ['headers', `${t('responseHeaders')} · ${response.headers.length}`],
            ['cookies', `${t('cookies')} · ${cookies.length}`],
          ] as Array<[ViewTab, string]>
        ).map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="resp-body">
        {tab === 'headers' ? (
          <table className="headers-table">
            <tbody>
              {response.headers.map((h, i) => (
                <tr key={i}>
                  <td>{h.key}</td>
                  <td>{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === 'cookies' ? (
          <>
            <div className="cookies-head">
              <span className="meta">
                {cookies.length === 0 ? t('noCookies') : t('cookiesSent')}
              </span>
              <button
                className="icon-btn framed"
                title={t('clearCookies')}
                disabled={!onClearCookies}
                onClick={onClearCookies}
              >
                <Icon name="trash" />
              </button>
            </div>
            {cookies.length > 0 && (
              <table className="headers-table">
                <tbody>
                  {cookies.map((c, i) => (
                    <tr key={i}>
                      <td>{c.name}</td>
                      <td>{c.value}</td>
                      <td className="cookie-from">
                        {c.from === 'jar' ? t('cookieFromJar') : t('cookieFromHeader')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          bodyView
        )}
      </div>
    </section>
  )
}
