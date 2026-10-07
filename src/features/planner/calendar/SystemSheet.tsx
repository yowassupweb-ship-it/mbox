import { ExternalLink, Zap } from 'lucide-react';
import { Sheet } from '../ui/overlay';
import { openTabKey } from '../nav';
import { dayLabel, parseLocal, SYSTEM_STATUS } from './model';
import { useCalendarUi } from './ui';

/** Системная автоматизация MBOX в календаре (SEO Wizard): что это, когда, чем кончилось — и переход к ней. Только чтение. */
export function SystemSheet() {
  const item = useCalendarUi((s) => s.systemItem);
  if (!item?.system) return null;
  const close = () => useCalendarUi.setState({ systemItem: null });
  const { system } = item;
  return (
    <Sheet
      title={system.source || 'Автоматизация'}
      onClose={close}
      footer={(
        <>
          <span className="ncal-foot-gap" />
          {system.tab && (
            <button type="button" className="nx-ghost" onClick={() => { close(); openTabKey(system.tab!); }}>
              <ExternalLink size={15} aria-hidden="true" /> Открыть {system.source || 'раздел'}
            </button>
          )}
          <button type="button" className="nx-primary" onClick={close}>Готово</button>
        </>
      )}
    >
      <div className="ncal-read">
        <h3 className="ncal-read-title"><Zap size={16} aria-hidden="true" /> {item.title}</h3>
        <p className="ncal-read-when">{dayLabel(parseLocal(item.start))}</p>
        <p className="ncal-read-row"><span className="ncal-mark-status" data-status={system.status}>{SYSTEM_STATUS[system.status]}</span></p>
        {system.status === 'off' && <p className="ncal-read-notes">Расписание есть, но сам запуск выключен на сервере (SEO_AUTORUN). Сбор можно запустить вручную в SEO Wizard.</p>}
        {system.detail && <p className="ncal-read-notes">{system.detail}</p>}
      </div>
    </Sheet>
  );
}
