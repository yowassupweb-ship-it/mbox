import { Bot, Zap } from 'lucide-react';
import { SYSTEM_STATUS, type CalEvent } from './model';

/**
 * Значки события рядом с названием: молния — автоматизация (в момент события агент получает задание),
 * робот с именем — событие поставил агент, у системной автоматизации — её статус. Видно, что в календаре
 * сделали агенты и что сработает само.
 */
export function EventMarks({ e, compact }: { e: CalEvent; compact?: boolean }) {
  return (
    <>
      {(e.automation || e.system) && <Zap size={compact ? 10 : 11} className="ncal-mark-auto" aria-label={e.system ? 'Автоматизация MBOX' : `Автоматизация: ${e.automation?.agent}`} />}
      {e.source && !compact && <span className="ncal-mark-agent" title={`Поставил ${e.source}`}><Bot size={11} aria-hidden="true" />{e.source}</span>}
      {e.source && compact && <Bot size={10} className="ncal-mark-agent-icon" aria-label={`Поставил ${e.source}`} />}
      {e.system && !compact && <span className="ncal-mark-status" data-status={e.system.status}>{SYSTEM_STATUS[e.system.status]}</span>}
    </>
  );
}
