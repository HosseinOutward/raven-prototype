import { Pin } from "lucide-react";
import { MessageText, type MentionContext } from "@/components/chat/MessageText";
import type { TreeNote } from "@/lib/api";
import { boardTime } from "@/lib/notes";
import { GroupedList } from "../atoms";


/** The space's pinned notes, at the top of the lobby. No author, no timestamps but an end. */
export function PinnedNotes({ notes, mentions }: { notes: TreeNote[]; mentions: MentionContext }) {
  if (!notes.length) return null;
  return (
    <section aria-label="Pinned notes">
      <GroupedList>
        {notes.map((note) => (
          <div key={note.id} className="flex items-start gap-3 px-3 py-2.5">
            <Pin className="mt-1 h-4 w-4 shrink-0 text-subtle" aria-hidden />
            <div className="min-w-0 flex-1">
              <MessageText body={note.title} mentions={mentions} className="text-body" />
              {note.description ? <MessageText body={note.description} mentions={mentions} className="mt-0.5 text-small text-muted-foreground" /> : null}
              {note.endsAt ? <p className="mt-1 text-caption text-subtle">Until {boardTime(note.endsAt)}</p> : null}
            </div>
          </div>
        ))}
      </GroupedList>
    </section>
  );
}
