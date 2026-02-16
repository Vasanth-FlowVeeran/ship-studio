import { usePluginContext } from '../context';

/** Returns the shell proxy for executing commands in the project directory. */
export function useShell() {
  return usePluginContext().shell;
}
