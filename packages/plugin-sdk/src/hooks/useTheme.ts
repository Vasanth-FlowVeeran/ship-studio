import { usePluginContext } from '../context';

/** Returns theme data (CSS variable values) for consistent styling. */
export function useTheme() {
  return usePluginContext().theme;
}
