import { usePluginContext } from '../context';

/** Returns the current project data, or null if no project is open. */
export function useProject() {
  return usePluginContext().project;
}
