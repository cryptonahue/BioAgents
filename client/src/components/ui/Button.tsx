import { ComponentChildren } from 'preact';
import { Icon } from '../icons';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * App variant -> Basecoat (Lyra) `data-variant`.
 *
 * Lyra models exactly seven button variants — `primary` (also the no-attribute
 * default), `secondary`, `outline`, `ghost`, `link` and `destructive` — read
 * from `basecoat-css/dist/styles/lyra.css`. The app's four map onto them:
 *
 *   primary   -> primary      Lyra paints `--primary`. That token is TEAL, not
 *                             the brand green: primary buttons are deliberately
 *                             rebranded. `--accent-color` survives untouched
 *                             everywhere it is still used explicitly.
 *   secondary -> outline      The app's secondary was a neutral surface with a
 *                             1px border. Lyra's `secondary` is a borderless
 *                             tinted fill; `outline` is the bordered neutral
 *                             button, so it is the honest match.
 *   ghost     -> ghost        Transparent, hover tints to `--muted`. Identical
 *                             intent.
 *   danger    -> destructive  Lyra's destructive is a TINTED red button, not a
 *                             solid red fill — the same shape as the app's old
 *                             `.btn-danger`. See buttons.css for the contrast
 *                             override it needs.
 *
 * Lyra has no brand-green CTA variant and none is reintroduced here: the only
 * green that survives is the one the sidebar's `.active` rules paint on top,
 * which is an additive app rule, not a button variant.
 */
const BASECOAT_VARIANT: Record<ButtonVariant, string> = {
  primary: 'primary',
  secondary: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
};

/**
 * App size -> Lyra `data-size`. Lyra supports `default` (h-8), `xs` (h-6),
 * `sm` (h-7), `lg` (h-9) and the four icon-only boxes `icon` (32px),
 * `icon-xs` (24px), `icon-sm` (28px) and `icon-lg` (36px).
 */
const BASECOAT_SIZE: Record<ButtonSize, string> = {
  sm: 'sm',
  md: 'default',
  lg: 'lg',
};

const BASECOAT_ICON_SIZE: Record<ButtonSize, string> = {
  sm: 'icon-sm',
  md: 'icon',
  lg: 'icon-lg',
};

const DEFAULT_ICON_PX: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 20 };

/**
 * Lyra force-sizes every icon inside a button:
 *
 *   .btn [&_svg:not([class*='size-'])]:size-4
 *
 * Phosphor renders `size` as width/height ATTRIBUTES, which any CSS property
 * beats — so without this opt-out, adopting `.btn` would silently clamp every
 * icon to 16px and turn the `iconSize` / `size` props of these two components
 * into no-ops. `:not([class*='size-'])` is Lyra's own escape hatch: an svg that
 * declares its own size class is left alone. This class exists purely to
 * satisfy that selector, so the size the caller asked for is what renders.
 */
export const BUTTON_ICON_CLASS = 'btn-icon-size-explicit';

export interface ButtonProps {
  children?: ComponentChildren;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  iconSize?: number;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  className?: string;
  title?: string;
  type?: 'button' | 'submit' | 'reset';
}

/**
 * Consistent Button component for the application.
 *
 * Renders Basecoat's `.btn` contract (`data-variant` / `data-size`). Preact
 * still owns all state and behavior — no Basecoat JS is loaded anywhere in this
 * app, and none is needed: Lyra's rules key off attributes we already render.
 */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  icon,
  iconSize,
  disabled = false,
  loading = false,
  onClick,
  className = '',
  title,
  type = 'button',
}: ButtonProps) {
  const iconOnly = Boolean(icon) && !children;
  const dataSize = iconOnly ? BASECOAT_ICON_SIZE[size] : BASECOAT_SIZE[size];
  const classes = ['btn', className].filter(Boolean).join(' ');
  const actualIconSize = iconSize || DEFAULT_ICON_PX[size];

  return (
    <button
      type={type}
      className={classes}
      data-variant={BASECOAT_VARIANT[variant]}
      data-size={dataSize}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={title}
    >
      {icon && <Icon name={icon} size={actualIconSize} className={BUTTON_ICON_CLASS} />}
      {children && <span className="btn-text">{children}</span>}
    </button>
  );
}
