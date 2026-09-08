import { useCallback, useEffect, useRef, useState } from "react";
import { type ConsoleApiError, toConsoleApiError } from "./api.js";

export interface Loaded<T> {
  state: "loading" | "ready" | "error";
  data?: T;
  error?: ConsoleApiError;
  reload: () => Promise<void>;
}

/** Discard late responses, including those from the previous bundle or an unmounted view. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const key = JSON.stringify(deps);
  const latest = useRef(load);
  latest.current = load;
  const active = useRef(key);
  const sequence = useRef(0);
  active.current = key;
  const [result, setResult] = useState<Omit<Loaded<T>, "reload"> & { key: string }>({
    key,
    state: "loading",
  });
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const data = await latest.current();
      if (request === sequence.current && active.current === key)
        setResult({ key, state: "ready", data });
    } catch (error) {
      if (request === sequence.current && active.current === key)
        setResult({ key, state: "error", error: toConsoleApiError(error) });
    }
  }, [key]);
  useEffect(() => {
    void reload();
    return () => {
      sequence.current++;
    };
  }, [reload]);
  return { ...(result.key === key ? result : { state: "loading" as const }), reload };
}
