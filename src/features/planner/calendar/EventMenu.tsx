import type { CSSProperties } from 'react';
import { CircleCheck, Columns2, Copy, ExternalLink, PanelTop, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { Menu, MenuItem, type MenuAnchor } from '../ui/overlay';
import { openTask } from '../nav';
import { duplicateEvent, openEvent, recolorEvent, removeEvent, toggleTaskDone } from './actions';
import { COLORS, colorVar, type CalEvent } from './model';

/** Контекстное меню события в сетке и в повестке дня. У задачи — открыть и отметить, у события — правка, цвет, удаление. */
export function EventMenu({ event: e, anchor, onClose }: { event: CalEvent; anchor: MenuAnchor; onClose: () => void }) {
  if (e.taskId) {
    const taskId = e.taskId;
    return (
      <Menu anchor={anchor} label={e.title || 'Задача'} onClose={onClose}>
        <MenuItem icon={<ExternalLink size={16} />} onSelect={() => { onClose(); openTask(taskId); }}>Открыть задачу</MenuItem>
        <MenuItem icon={<PanelTop size={16} />} onSelect={() => { onClose(); openTask(taskId, 'tab'); }}>Открыть в новой вкладке</MenuItem>
        <MenuItem icon={<Columns2 size={16} />} onSelect={() => { onClose(); openTask(taskId, 'split'); }}>Открыть во второй области</MenuItem>
        <MenuItem icon={e.done ? <RotateCcw size={16} /> : <CircleCheck size={16} />} onSelect={() => { onClose(); toggleTaskDone(e); }}>
          {e.done ? 'Вернуть в работу' : 'Отметить выполненной'}
        </MenuItem>
      </Menu>
    );
  }
  return (
    <Menu anchor={anchor} label={e.title || 'Событие'} onClose={onClose}>
      <MenuItem icon={<Pencil size={16} />} onSelect={() => { onClose(); openEvent(e); }}>Открыть</MenuItem>
      <MenuItem icon={<Copy size={16} />} onSelect={() => { onClose(); duplicateEvent(e); }}>Дублировать…</MenuItem>
      <div className="nx-menu-sep" />
      <div className="ncal-menu-colors" role="group" aria-label="Цвет">
        {COLORS.map((c) => (
          <button key={c.id} type="button" className="ncal-swatch" aria-label={c.label} title={c.label}
            aria-checked={(e.color || 'blue') === c.id} role="radio"
            style={{ '--ev': colorVar(c.id) } as CSSProperties}
            onClick={() => { onClose(); recolorEvent(e, c.id); }} />
        ))}
      </div>
      <div className="nx-menu-sep" />
      <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => { onClose(); void removeEvent(e); }}>Удалить</MenuItem>
    </Menu>
  );
}
