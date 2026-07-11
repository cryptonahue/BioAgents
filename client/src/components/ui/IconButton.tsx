import { Icon } from '../icons';
import { BUTTON_ICON_CLASS } from './Button';

export interface IconButtonProps {
  icon: string;
  size?: number;
  onClick?: (e?: any) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  variant?: 'default' | 'ghost' | 'danger';
}

/**
 * IconButton variant -> Basecoat (Lyra) `data-variant`.
 *
 * The old `.icon-btn` base was already a ghost button (transparent fill,
 * transparent border, tints to `--bg-hover` on hover), so `default` and `ghost`
 * collapse onto the same Lyra variant. They are kept as separate API values
 * because call sites pass both.
 */
const BASECOAT_VARIANT: Record<NonNullable<IconButtonProps['variant']>, string> = {
  default: 'ghost',
  ghost: 'ghost',
  danger: 'destructive',
};

/**
 * Icon-only button component.
 *
 * `data-size="icon-sm"` is Lyra's 28px square box, which is what `.icon-btn`
 * measured (16px icon + 6px padding). `size` continues to control the ICON, not
 * the box — see BUTTON_ICON_CLASS in Button.tsx for why that still works once
 * the element carries `.btn`.
 */
export function IconButton({
  icon,
  size = 16,
  onClick,
  disabled = false,
  className = '',
  title,
  variant = 'default',
}: IconButtonProps) {
  const classes = ['btn', className].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={classes}
      data-variant={BASECOAT_VARIANT[variant]}
      data-size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <Icon name={icon} size={size} className={BUTTON_ICON_CLASS} />
    </button>
  );
}
