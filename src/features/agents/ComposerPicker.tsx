import { useRef, useState } from "react";
import { AnchoredPopover } from "../../components/AnchoredPopover";
import { Check, ChevronDown } from "lucide-react";

export type PickerOption = { value: string; label: string; hint?: string };

/**
 * Выпадающий список у поля ввода.
 *
 * Нативный <select> здесь не годился: Chromium рисует его список силами системы — белый на тёмной
 * теме, с нечитаемыми пунктами, без места под пояснение к варианту, и он выпадает за пределы окна
 * (а значит и поверх встроенного браузера его не положить). Свой список решает всё сразу: тема,
 * подписи-пояснения и markOverlay, который убирает страницу браузера, пока список открыт.
 * Раскрывается вверх — поле ввода стоит у нижнего края.
 */
export function ComposerPicker({ label, value, onChange, options, placeholder, defaultValue = "", footnote = "" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: PickerOption[];
  placeholder: string;
  /** Вариант, который сработает сам собой: он и есть строка «по умолчанию», в списке не повторяется. */
  defaultValue?: string;
  /** Пояснение под списком (например, свежесть каталога моделей). */
  footnote?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const current = options.find((item) => item.value === value);
  const rest = options.filter((item) => item.value !== defaultValue);

  const pick = (next: string) => { onChange(next); setOpen(false); };

  return (
    <div className="console-picker">
      <button
        ref={buttonRef}
        type="button"
        className={open ? "console-picker-btn is-open" : "console-picker-btn"}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <span>{current ? current.label : placeholder}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <AnchoredPopover anchorRef={buttonRef} onClose={() => setOpen(false)} align="end" prefer="auto" className="console-picker-menu" label={label}>
          <button type="button" role="option" aria-selected={!value} className={!value ? "is-current" : undefined} onClick={() => pick("")}>
            <span>
              <strong>{placeholder}</strong>
              <small>по умолчанию</small>
            </span>
            {!value && <Check size={13} />}
          </button>
          {rest.map((item) => (
            <button
              type="button"
              key={item.value}
              role="option"
              aria-selected={item.value === value}
              className={item.value === value ? "is-current" : undefined}
              onClick={() => pick(item.value)}
            >
              <span>
                <strong>{item.label}</strong>
                {item.hint && <small>{item.hint}</small>}
              </span>
              {item.value === value && <Check size={13} />}
            </button>
          ))}
          {footnote && <p className="console-picker-note">{footnote}</p>}
        </AnchoredPopover>
      )}
    </div>
  );
}
