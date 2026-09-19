import type { T } from '../lib/i18n'
import { newEnvId, type Environment } from '../lib/environments'
import { Icon } from './Icon'

/**
 * 环境配置: the named base URLs requests can target. Rows edit in place and
 * every change flows up through onChange, so the app persists as the user
 * types — the dialog itself has nothing to submit. The radio column picks the
 * environment requests resolve against; the first row is "no environment",
 * which leaves URLs exactly as typed.
 */
export function EnvDialog({
  t,
  environments,
  activeId,
  onChange,
  onActivate,
  onClose,
}: {
  t: T
  environments: Environment[]
  activeId: string
  onChange: (list: Environment[]) => void
  onActivate: (id: string) => void
  onClose: () => void
}) {
  const update = (id: string, patch: Partial<Environment>) =>
    onChange(environments.map(env => (env.id === id ? { ...env, ...patch } : env)))

  const remove = (id: string) => {
    onChange(environments.filter(env => env.id !== id))
    if (id === activeId) onActivate('')
  }

  const add = () => {
    // A fresh row copies no settings, just a name that does not collide with
    // an earlier untitled addition.
    const base = t('envCustom')
    const used = environments.filter(env => env.name === base).length
    const name = used ? `${base} ${used + 1}` : base
    onChange([...environments, { id: newEnvId(), name, baseUrl: '' }])
  }

  return (
    <div className="dlg-backdrop" onClick={onClose}>
      <div className="dlg dlg-wide" role="dialog" aria-label={t('environmentConfig')} onClick={e => e.stopPropagation()}>
        <div className="dlg-head">
          <h3>
            <Icon name="globe" /> {t('environmentConfig')}
          </h3>
          <button className="icon-btn" onClick={onClose} title={t('close')} aria-label={t('close')}>
            <Icon name="close" />
          </button>
        </div>
        <div className="env-list" role="radiogroup" aria-label={t('environment')}>
          <div className="env-row env-head" aria-hidden="true">
            <span />
            <span>{t('envName')}</span>
            <span>{t('baseUrl')}</span>
            <span />
          </div>
          <label className="env-row env-none">
            <input
              type="radio"
              name="env-active"
              checked={!activeId}
              onChange={() => onActivate('')}
              aria-label={t('noEnvironment')}
            />
            <span>{t('noEnvironment')}</span>
          </label>
          {environments.map(env => (
            <div className="env-row" key={env.id}>
              <input
                type="radio"
                name="env-active"
                checked={activeId === env.id}
                onChange={() => onActivate(env.id)}
                aria-label={`${t('useEnvironment')}: ${env.name}`}
                title={t('useEnvironment')}
              />
              <input
                className="dbx-input env-name"
                value={env.name}
                placeholder={t('envName')}
                aria-label={t('envName')}
                onChange={e => update(env.id, { name: e.target.value })}
              />
              <input
                className="dbx-input env-base"
                value={env.baseUrl}
                placeholder="https://api.example.com"
                aria-label={`${t('baseUrl')} (${env.name || t('envName')})`}
                onChange={e => update(env.id, { baseUrl: e.target.value })}
              />
              <button
                className="icon-btn"
                title={t('delete')}
                aria-label={`${t('delete')}: ${env.name}`}
                onClick={() => remove(env.id)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="env-foot">
          <button className="ghost sm" onClick={add}>
            <Icon name="plus" size={13} /> {t('addEnvironment')}
          </button>
          <span className="env-hint">{t('envHint')}</span>
        </div>
      </div>
    </div>
  )
}
