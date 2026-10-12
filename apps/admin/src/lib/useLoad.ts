import { useCallback, useEffect, useRef, useState } from "react";

export interface Loaded<T> {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => void;
  /** Replace the data with a fresher copy, such as the one a change returned. */
  set: (data: T) => void;
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong. Try again.";
}

/** Loads something when `key` changes and keeps only the newest answer. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [turn, setTurn] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let current = true;
    setLoading(true);
    loadRef
      .current()
      .then((result) => {
        if (!current) return;
        setData(result);
        setError("");
      })
      .catch((cause: unknown) => {
        if (current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [key, turn]);

  const reload = useCallback(() => setTurn((value) => value + 1), []);
  return { data, error, loading, reload, set: setData };
}
