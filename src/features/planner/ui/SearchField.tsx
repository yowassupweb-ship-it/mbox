import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';

/**
 * Поле поиска нового шара — одно на все разделы: стеклянная капсула со
 * значком лупы и крестиком очистки (свой, системный у type=search скрыт —
 * иначе на Safari их было два). Esc очищает, повторный Esc снимает фокус.
 */
export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Подпись для скринридера, если отличается от placeholder. */
  label?: string;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, placeholder, label, className, autoFocus, onKeyDown }, ref,
) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current as HTMLInputElement);
  return (
    <label className={['nx-field', 'nx-search', className].filter(Boolean).join(' ')}>
      <Search size={15} aria-hidden="true" />
      <span className="nx-sr">{label || placeholder}</span>
      <input
        ref={input}
        type="search"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (value) onChange(''); else e.currentTarget.blur();
          }
          onKeyDown?.(e);
        }}
      />
      {value && (
        <button type="button" className="nx-icon-btn nx-search-clear" onClick={() => { onChange(''); input.current?.focus(); }} aria-label="Очистить поиск">
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </label>
  );
});
