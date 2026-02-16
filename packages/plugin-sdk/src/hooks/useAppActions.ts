import { usePluginContext } from '../context';

/** Returns the app actions proxy (showToast, refreshGitStatus, etc). */
export function useAppActions() {
  return usePluginContext().actions;
}
