import { Avatar } from "@/components/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { clockTime, fullTime } from "@/lib/chat/time";
import type { ChatSeenReader } from "@/lib/chat/types";
import { AvatarStack } from "@/shells/ravenv1/atoms";

const person = (reader: ChatSeenReader) => reader.displayName || reader.username;

/**
 * Under the conversation's last message: who has seen it. In a direct message that is a time,
 * in a group or nest a few faces that open the names and times. Direct messages show it only
 * under your own last message, since the other reader there is you.
 */
export function SeenBy({ direct, readers, fallbackAt }: { direct: boolean; readers: ChatSeenReader[]; fallbackAt?: string }) {
  const first = readers[0];
  if (direct) {
    const at = first?.at ?? fallbackAt;
    if (!at) return null;
    return (
      <div className="mt-0.5 flex justify-end pr-1 text-caption text-subtle">
        <span title={fullTime(at)} className="tabular-nums">Seen {clockTime(at)}</span>
      </div>
    );
  }
  if (readers.length === 0) return null;
  return (
    <div className="mt-0.5 flex justify-end pr-1">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`Seen by ${readers.map(person).join(", ")}`} className="flex items-center gap-1.5 rounded-full py-0.5 pl-1.5 pr-0.5 text-caption text-subtle transition-colors hover:text-foreground">
            <span>Seen</span>
            <AvatarStack people={readers.map((reader) => ({ id: reader.userId, name: person(reader) }))} max={4} surface="canvas" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-64 p-1">
          <p className="px-2 py-1.5 text-caption text-subtle">Seen by {readers.length}</p>
          <ul className="max-h-64 overflow-y-auto">
            {readers.map((reader) => (
              <li key={reader.userId} className="flex items-center gap-2 rounded-control px-2 py-1.5">
                <Avatar name={person(reader)} src={api.userAvatarUrl(reader.userId)} className="h-6 w-6" />
                <span className="min-w-0 flex-1 truncate text-small">{person(reader)}</span>
                <time dateTime={reader.at} title={fullTime(reader.at)} className="text-caption tabular-nums text-subtle">{clockTime(reader.at)}</time>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
