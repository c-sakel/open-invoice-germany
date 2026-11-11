import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger-quiet";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-control)] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-pen text-on-accent hover:bg-pen/90",
  secondary: "bg-sheet text-ink ring-1 ring-inset ring-rule-strong hover:bg-well",
  quiet: "text-ink-soft hover:bg-well hover:text-ink",
  "danger-quiet": "text-stamp hover:bg-well",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-[13px]",
  md: "px-3.5 py-2 text-sm",
};

/** Klassen fuer Buttons und Links im Button-Look (z. B. `<Link className={buttonClass("primary")}>`). */
export function buttonClass(variant: ButtonVariant, size: ButtonSize = "md"): string {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant, size = "md", className, type = "button", ...rest }: ButtonProps) {
  const cls = buttonClass(variant, size);
  return <button type={type} className={className ? `${cls} ${className}` : cls} {...rest} />;
}
