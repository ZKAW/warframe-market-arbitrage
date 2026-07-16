import { type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'tab' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  isActive?: boolean;
  icon?: ReactNode;
}

export default function Button({
  variant = 'ghost',
  isActive = false,
  icon,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, isActive ? 'active' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} aria-pressed={variant === 'tab' ? isActive : undefined} {...rest}>
      {icon}
      {children}
    </button>
  );
}
