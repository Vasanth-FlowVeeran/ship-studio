import { usePluginContext } from '../context';

/** Returns the storage proxy for reading/writing plugin-scoped data. */
export function usePluginStorage() {
  return usePluginContext().storage;
}
