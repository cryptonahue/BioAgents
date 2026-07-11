import { Icon } from "./icons";
import { useTheme } from "../hooks";

interface ThemeToggleProps {
  size?: number;
  className?: string;
}

/**
 * Light/dark theme toggle.
 *
 * Reads and writes ThemeContext only — the `dark` class on <html> and the
 * localStorage key stay owned by the provider. This component holds no state.
 *
 * It does NOT reuse `ui/IconButton` even though it looks like one: IconButton
 * forwards neither `aria-label` nor any state attribute, and an icon-only
 * control that changes meaning as you press it needs both. Rather than widen
 * IconButton's API for a single caller, this is a plain <button>.
 *
 * ARIA: deliberately a normal action button — no `aria-pressed`, no
 * `role="switch"`. Both of those describe a control whose *label stays fixed*
 * while its state flips, and the ARIA Authoring Practices are explicit that a
 * toggle button's label must not change with its state. This button's
 * accessible name IS the action ("Switch to light theme"), which already tells
 * a screen-reader user both where they are and what pressing it will do. Adding
 * `aria-pressed` on top would announce "Switch to light theme, pressed" —
 * redundant at best, and contradictory to a user parsing "pressed" as "light is
 * on". One unambiguous announcement beats two competing ones.
 */
export function ThemeToggle({ size = 16, className = "" }: ThemeToggleProps) {
  const { isDark, toggleTheme } = useTheme();

  // Names the ACTION, not the current state, and flips with it.
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";
  const classes = ["theme-toggle-btn", className].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      className={classes}
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      {/* Shows the theme you are about to GET, matching what the label says. */}
      <Icon name={isDark ? "sun" : "moon"} size={size} />
    </button>
  );
}
