import { memo, type CSSProperties } from 'react';
import { AgentAvatar } from '../../../components/AgentAvatar';
import { initials, tintFor } from './format';

/**
 * Аватар в планировщике: агент («agent:…») — его значок MBOX, человек — инициалы на цвете категории.
 * Внешних картинок нет: десктоп работает и без интернета.
 */
export const Avatar = memo(function Avatar({ name, seed, src, size }: {
  name: string;
  seed: string;
  src?: string;
  person?: boolean;
  size?: number;
}) {
  const px = size || 40;
  if (seed.startsWith('agent:')) {
    return <span className="nx-avatar" data-kind="agent" style={{ '--size': `${px}px` } as CSSProperties} aria-hidden="true"><AgentAvatar name={seed.slice(6)} size={px} /></span>;
  }
  const style = { '--tint': tintFor(seed), '--size': `${px}px` } as CSSProperties;
  return (
    <span className="nx-avatar" style={style} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : initials(name)}
    </span>
  );
});
