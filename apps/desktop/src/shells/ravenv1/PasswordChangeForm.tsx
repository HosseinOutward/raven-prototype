import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const MIN_LENGTH = 10;

/**
 * The fields for replacing your own password. Used in settings and on the screen someone
 * with a temporary password is held at. Errors stay beside the fields.
 */
export function PasswordChangeForm({
  currentLabel,
  onChange,
  onChanged,
}: {
  currentLabel: string;
  onChange: (currentPassword: string, newPassword: string) => Promise<void>;
  onChanged?: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (working) return;
    setDone(false);
    if (next.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (next !== again) {
      setError("The two new passwords don’t match.");
      return;
    }
    setWorking(true);
    setError("");
    try {
      await onChange(current, next);
      setCurrent("");
      setNext("");
      setAgain("");
      setDone(true);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Your password could not be changed. Try again.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <form className="max-w-sm space-y-3" onSubmit={(event) => void submit(event)}>
      <label className="block space-y-1.5 text-small text-muted-foreground">
        {currentLabel}
        <Input type="password" value={current} autoComplete="current-password" onChange={(event) => setCurrent(event.currentTarget.value)} />
      </label>
      <label className="block space-y-1.5 text-small text-muted-foreground">
        New password
        <Input type="password" value={next} autoComplete="new-password" onChange={(event) => setNext(event.currentTarget.value)} />
      </label>
      <label className="block space-y-1.5 text-small text-muted-foreground">
        New password again
        <Input type="password" value={again} autoComplete="new-password" onChange={(event) => setAgain(event.currentTarget.value)} />
      </label>
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={working || !current || !next || !again}>{working ? "Saving…" : "Change password"}</Button>
        {done ? <span className="text-small text-muted-foreground">Password changed.</span> : null}
      </div>
    </form>
  );
}
