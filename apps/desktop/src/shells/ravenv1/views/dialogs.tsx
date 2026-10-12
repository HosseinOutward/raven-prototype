import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TreeRole } from "@/lib/api";

/** Ask for one name and create something with it. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} widthClassName="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const nextName = name.trim();
          if (!nextName || working) return;
          setWorking(true);
          void onSubmit(nextName)
            .catch(() => undefined)
            .finally(() => setWorking(false));
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          {label}
          <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={placeholder} maxLength={80} autoFocus />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={working || !name.trim()}>{working ? "Creating…" : submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export const TREE_ROLE_LABEL: Record<TreeRole, string> = {
  member: "Member",
  moderator: "Moderator",
  owner: "Owner",
};

export function AddTreeMemberDialog({
  open,
  onOpenChange,
  title,
  canAssignRoles,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Adding someone as a moderator is giving out a role, which is the owner's to do. */
  canAssignRoles: boolean;
  onAdd: (username: string, role: TreeRole) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<TreeRole>("member");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername("");
    setRole("member");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description="They are added straight away and can see who is here." widthClassName="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const nextUsername = username.trim().replace(/^@/, "");
          if (!nextUsername || working) return;
          setWorking(true);
          void onAdd(nextUsername, role)
            .catch(() => undefined)
            .finally(() => setWorking(false));
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Username
          <Input value={username} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="mina" autoFocus />
        </label>
        {canAssignRoles ? (
          <div className="space-y-1.5 text-small text-muted-foreground">
            Role
            <Select value={role} onValueChange={(value) => setRole(value as TreeRole)}>
              <SelectTrigger>
                <SelectValue>{TREE_ROLE_LABEL[role]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="moderator">Moderator</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={working || !username.trim()}>{working ? "Adding…" : "Add person"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
