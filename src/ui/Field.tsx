import { useState } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

export function Field({ label, hint, className = "", children }: { label?: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={`field${className ? ` ${className}` : ""}`}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

export function TextInput({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string }) {
  if (!label && !hint) return <input {...rest} />;
  return <Field label={label} hint={hint}><input {...rest} /></Field>;
}

export function TextArea({ label, hint, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string }) {
  if (!label && !hint) return <textarea {...rest} />;
  return <Field label={label} hint={hint}><textarea {...rest} /></Field>;
}

export function Select({ label, hint, options, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; hint?: string; options?: Array<{ value: string; label: string }> }) {
  const select = (
    <select {...rest}>
      {options ? options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>) : children}
    </select>
  );
  if (!label && !hint) return select;
  return <Field label={label} hint={hint}>{select}</Field>;
}

/** Пароль по умолчанию скрыт — показывается только по явному действию. */
export function PasswordInput({ ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="password-field">
      <input {...rest} type={visible ? "text" : "password"} />
      <button aria-label={visible ? "Скрыть пароль" : "Показать пароль"} type="button" onClick={() => setVisible((value) => !value)}>
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="error-text">{children}</p>;
}
