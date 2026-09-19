import { useMemo, useState } from 'react'
import { copyText } from '../lib/clipboard'
import { generateCode, CODE_LANGUAGES, type CodeLanguage } from '../lib/codegen'
import type { T } from '../lib/i18n'
import type { RequestSpec } from '../lib/types'
import { Icon } from './Icon'

export function CodeDialog({
  t,
  spec,
  onClose,
}: {
  t: T
  spec: RequestSpec
  onClose: () => void
}) {
  const [lang, setLang] = useState<CodeLanguage>('curl')
  const [copied, setCopied] = useState(false)
  const code = useMemo(() => generateCode(spec, lang), [spec, lang])
  return (
    <div className="dlg-backdrop" onClick={onClose}>
      <div className="dlg dlg-wide" role="dialog" aria-label={t('generateCode')} onClick={e => e.stopPropagation()}>
        <div className="dlg-head">
          <h3>
            <Icon name="code" /> {t('generateCode')}
          </h3>
          <button
            className="icon-btn"
            onClick={onClose}
            title={t('close')}
            aria-label={t('close')}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="chip-row">
          {CODE_LANGUAGES.map(l => (
            <button
              key={l.id}
              className={lang === l.id ? 'chip active' : 'chip'}
              onClick={() => setLang(l.id)}
            >
              {l.label}
            </button>
          ))}
          <span className="spacer" />
          <button
            className="ghost sm"
            onClick={() => {
              void copyText(code).then(ok => {
                if (!ok) return
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? t('copied') : t('copy')}
          </button>
        </div>
        <pre className="dlg-code">{code}</pre>
      </div>
    </div>
  )
}
