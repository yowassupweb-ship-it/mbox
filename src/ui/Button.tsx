import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type ButtonVariant = "primary" | "ghost" | "icon" | "danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: LucideIcon;
  iconSize?: number;
  children?: ReactNode;
};

const variantClass: Record<ButtonVariant, string> = {
  primary: "primary-action",
  ghost: "ghost-action",
  icon: "icon-button",
  danger: "primary-action danger-action",
};

export function Button({ variant = "primary", icon: Icon, iconSize = 18, className = "", children, type = "button", ...rest }: ButtonProps) {
  return (
    <button className={`${variantClass[variant]}${className ? ` ${className}` : ""}`} type={type} {...rest}>
      {Icon && <Icon size={iconSize} />}
      {children != null && <span>{children}</span>}
    </button>
  );
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export function saveLabel(state: SaveState, idle: string) {
  if (state === "saving") return "Сохраняю";
  if (state === "saved") return "Сохранено";
  if (state === "error") return "Ошибка";
  return idle;
}

type SaveButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  state: SaveState;
  idleLabel?: string;
  variant?: ButtonVariant;
};

export function SaveButton({ state, idleLabel = "Сохранить", variant = "primary", className = "", disabled, ...rest }: SaveButtonProps) {
  return (
    <Button
      variant={variant}
      className={`${className} save-button is-${state}`.trim()}
      disabled={disabled || state === "saving"}
      {...rest}
    >
      {saveLabel(state, idleLabel)}
    </Button>
  );
}
