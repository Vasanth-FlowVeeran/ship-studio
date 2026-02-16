import { usePluginContext } from '../context';

/** Returns the showToast function for displaying notifications. */
export function useToast() {
  return usePluginContext().actions.showToast;
}
