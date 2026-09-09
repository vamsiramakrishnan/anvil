import { useCallback, useEffect, useRef, useState } from "react";
import { type ConsoleApiError, toConsoleApiError } from "./api.js";

export interface Loaded<T> {
  state: "loading" | "ready" | "error";
  data?: T;
  error?: ConsoleApiError;
  refreshing: boolean;
  reload: () => Promise<void>;
}

/** Late responses cannot cross resource boundaries or undo a newer refresh. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const key = JSON.stringify(deps);
  const [result, setResult] = useState<Omit<Loaded<T>, "reload"> & { key: string }>({
    key,
    state: "loading",
    refreshing: false,
  });
  const latest = useRef(load);
  latest.current = load;
  const serial = useRef(0);
  const reload = useCallback(async () => {
    const request = ++serial.current;
    setResult((old) =>
      old.key === key && old.data
        ? { ...old, refreshing: true }
        : { key, state: "loading", refreshing: true },
    );
    try {
      const data = await latest.current();
      if (request === serial.current) setResult({ key, state: "ready", data, refreshing: false });
    } catch (error) {
      if (request === serial.current)
        setResult({ key, state: "error", error: toConsoleApiError(error), refreshing: false });
    }
  }, [key]);
  useEffect(() => {
    void reload();
    return () => {
      serial.current++;
    };
  }, [reload]);
  return result.key === key
    ? { ...result, reload }
    : { state: "loading", refreshing: true, reload };
}
