import { useThemeContext } from '../contexts/ThemeContext';

/**
 * Light/dark theme hook.
 *
 * Returns the active theme, a boolean shortcut, and the setter/toggle.
 * Consumes ThemeContext so the `dark` class on <html> stays a single
 * source of truth.
 */
export function useTheme() {
  return useThemeContext();
}
