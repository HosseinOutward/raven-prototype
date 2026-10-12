import { useEffect, useMemo, useState } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, Hash, MoreHorizontal, Pencil, Trash2, Volume2 } from "lucide-react";
import { RenameDialog } from "@/components/chat/ChatDialogs";
import { UnreadCount } from "@/components/chat/ConversationRow";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Nest, TreeDetails } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import { canMoveCategory, entryKey, layoutSections, moveCategory, moveEntry, toEntries, toLayoutRequest, type ArrangeEntry, type NestRef } from "@/lib/chat/layout";
import { textNestsOfTree } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import type { TreeCategory } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { GroupedList, LiveDot, SectionLabel } from "../atoms";
import { lifecycleLabel, type RavenShellData, type RavenView } from "../state";
import { useChatState } from "../useChat";
import { nestView } from "./shared";

/**
 * A tree's nests as its owners arranged them: categories, with text and voice nests in
 * order inside each. Owners and moderators can switch to arranging, where rows are
 * dragged (or moved with the keyboard) and categories are moved as a block.
 */
export function TreeNestsSection({
  details,
  data,
  chat,
  canManage,
  arranging,
  onArrangingChange,
  onNavigate,
}: {
  details: TreeDetails;
  data: RavenShellData;
  chat: ChatStore;
  canManage: boolean;
  arranging: boolean;
  onArrangingChange: (arranging: boolean) => void;
  onNavigate: (view: RavenView) => void;
}) {
  const treeId = details.tree.id;
  const state = useChatState(chat);
  const layout = state?.layouts[treeId];
  const nestPlural = data.labels.nestPlural;
  const [renaming, setRenaming] = useState<TreeCategory | null>(null);
  const [deleting, setDeleting] = useState<TreeCategory | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void chat.loadLayout(treeId).catch(() => undefined);
  }, [chat, treeId]);

  const voiceNests = useMemo(() => [...details.activeNests, ...details.inactiveNests], [details.activeNests, details.inactiveNests]);
  const voiceById = useMemo(() => new Map(voiceNests.map((nest) => [nest.id, nest])), [voiceNests]);
  const textNests = useMemo(() => (state ? textNestsOfTree(state, treeId) : []), [state, treeId]);
  const textById = useMemo(() => new Map(textNests.map((nest) => [nest.summary.id, nest.summary])), [textNests]);

  const sections = useMemo(() => {
    const oldestFirst = [...textNests].sort((a, b) => a.summary.createdAt.localeCompare(b.summary.createdAt));
    const existing: NestRef[] = [
      ...oldestFirst.map((nest) => ({ kind: "text" as const, id: nest.summary.id })),
      ...voiceNests.map((nest) => ({ kind: "voice" as const, id: nest.id })),
    ];
    return layoutSections(layout, existing);
  }, [layout, textNests, voiceNests]);

  const nameOf = (ref: NestRef) => (ref.kind === "text" ? textById.get(ref.id)?.name : voiceById.get(ref.id)?.name) ?? "";

  if (arranging) {
    return (
      <ArrangeNests
        initial={toEntries(sections, nameOf)}
        nestPlural={nestPlural}
        onCancel={() => onArrangingChange(false)}
        onSave={async (entries) => {
          await chat.saveLayout(treeId, toLayoutRequest(entries));
          onArrangingChange(false);
        }}
      />
    );
  }

  const hasCategories = sections.length > 1;
  return (
    <>
      {sections.map((section) => {
        if (section.items.length === 0 && (!section.category || !canManage)) return null;
        return (
          <section key={section.category?.id ?? "top"}>
            <SectionLabel
              className="mb-1"
              action={
                section.category && canManage ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`More for ${section.category.name}`} className="flex h-6 w-6 items-center justify-center rounded-chip text-subtle transition-colors hover:bg-secondary hover:text-foreground">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setRenaming(section.category)}>
                        <Pencil className="text-muted-foreground" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem destructive onSelect={() => setDeleting(section.category)}>
                        <Trash2 />
                        Delete category
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : undefined
              }
            >
              {section.category ? <bdi>{section.category.name}</bdi> : hasCategories ? "No category" : nestPlural}
            </SectionLabel>
            {section.items.length ? (
              <GroupedList>
                {section.items.map((ref) =>
                  ref.kind === "text" ? (
                    <TextNestRow key={`text:${ref.id}`} name={nameOf(ref)} unread={textById.get(ref.id)?.unreadCount ?? 0} onOpen={() => onNavigate({ kind: "chat", id: ref.id })} />
                  ) : (
                    <VoiceNestRow key={`voice:${ref.id}`} nest={voiceById.get(ref.id)!} onOpen={(nest) => onNavigate(nestView(nest))} />
                  ),
                )}
              </GroupedList>
            ) : (
              <p className="px-1 text-small text-muted-foreground">Nothing here yet. Use Arrange to move something in.</p>
            )}
          </section>
        );
      })}

      <RenameDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        title="Rename category"
        current={renaming?.name ?? ""}
        onRename={async (name) => {
          if (renaming) await chat.renameCategory(treeId, renaming.id, name);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete the category “${deleting?.name ?? ""}”?`}
        description={`The ${nestPlural.toLowerCase()} in it are kept, without a category.`}
        confirmLabel="Delete category"
        destructive
        busy={working}
        onConfirm={async () => {
          if (!deleting) return;
          setWorking(true);
          try {
            await chat.deleteCategory(treeId, deleting.id);
            setDeleting(null);
          } catch {
            // The category is still listed; the person can try again.
          } finally {
            setWorking(false);
          }
        }}
      />
    </>
  );
}

function TextNestRow({ name, unread, onOpen }: { name: string; unread: number; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group flex h-11 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-secondary">
      <Hash className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
      <span className={cn("min-w-0 flex-1 truncate text-body", unread > 0 && "font-medium")}><bdi>{name}</bdi></span>
      <UnreadCount count={unread} />
      <ChevronRight className="h-4 w-4 shrink-0 text-subtle transition-colors group-hover:text-foreground" />
    </button>
  );
}

function VoiceNestRow({ nest, onOpen }: { nest: Nest; onOpen: (nest: Nest) => void }) {
  const live = nest.lifecycleState === "active";
  const state = lifecycleLabel(nest);
  return (
    <button type="button" onClick={() => onOpen(nest)} className="group flex h-11 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-secondary">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {live ? <LiveDot /> : <span className="h-1.5 w-1.5 rounded-full bg-subtle/60" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1 truncate text-body"><bdi>{nest.name}</bdi></span>
      {state !== "Empty" && state !== "Created" ? <span className="shrink-0 text-caption text-muted-foreground">{state}</span> : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-subtle transition-colors group-hover:text-foreground" />
    </button>
  );
}

// ---- arranging -------------------------------------------------------------------------

function ArrangeNests({
  initial,
  nestPlural,
  onCancel,
  onSave,
}: {
  initial: ArrangeEntry[];
  nestPlural: string;
  onCancel: () => void;
  onSave: (entries: ArrangeEntry[]) => Promise<void>;
}) {
  const [entries, setEntries] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so a click is still a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const keys = useMemo(() => entries.map(entryKey), [entries]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setEntries((current) => {
      const order = current.map(entryKey);
      return moveEntry(current, order.indexOf(String(active.id)), order.indexOf(String(over.id)));
    });
  };

  return (
    <section>
      <SectionLabel
        className="mb-1"
        action={
          <span className="flex items-center gap-1.5">
            <Button size="xs" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button>
            <Button
              size="xs"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                setError("");
                void onSave(entries)
                  .catch((failure) => setError(failureText(failure, "Couldn’t save the arrangement.")))
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? "Saving…" : "Done"}
            </Button>
          </span>
        }
      >
        Arrange {nestPlural.toLowerCase()}
      </SectionLabel>
      <p className="mb-2 text-small text-muted-foreground">
        Drag a row by its handle, or focus the handle and press Space, then the arrow keys. A row belongs to the category above it.
      </p>
      {error ? <p className="mb-2 rounded-card bg-destructive/10 px-3.5 py-3 text-small" role="alert">{error}</p> : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <GroupedList>
            {entries.map((entry) =>
              entry.type === "category" ? (
                <ArrangeCategoryRow
                  key={entryKey(entry)}
                  entry={entry}
                  canMoveUp={canMoveCategory(entries, entry.id, -1)}
                  canMoveDown={canMoveCategory(entries, entry.id, 1)}
                  onMove={(direction) => setEntries((current) => moveCategory(current, entry.id, direction))}
                />
              ) : (
                <ArrangeItemRow key={entryKey(entry)} entry={entry} />
              ),
            )}
          </GroupedList>
        </SortableContext>
      </DndContext>
    </section>
  );
}

function ArrangeItemRow({ entry }: { entry: Extract<ArrangeEntry, { type: "item" }> }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: entryKey(entry) });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex h-11 items-center gap-2 bg-secondary/50 pl-1.5 pr-3.5", isDragging && "relative z-10 rounded-control bg-accent shadow-raised")}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`Move ${entry.name}`}
        className="flex h-8 w-7 shrink-0 cursor-grab items-center justify-center rounded-control text-subtle transition-colors hover:bg-accent hover:text-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {entry.kind === "text" ? <Hash className="h-4 w-4 shrink-0 text-subtle" aria-hidden /> : <Volume2 className="h-4 w-4 shrink-0 text-subtle" aria-hidden />}
      <span className="min-w-0 flex-1 truncate text-body"><bdi>{entry.name}</bdi></span>
    </div>
  );
}

function ArrangeCategoryRow({
  entry,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  entry: Extract<ArrangeEntry, { type: "category" }>;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  // Part of the sortable list so that rows can be dropped around it, but not draggable
  // itself: a category moves, with its rows, through the buttons.
  const { setNodeRef, transform, transition } = useSortable({ id: entryKey(entry), disabled: { draggable: true } });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="flex h-10 items-center gap-1 bg-secondary px-3.5">
      <span className="min-w-0 flex-1 truncate text-caption font-medium text-muted-foreground"><bdi>{entry.name}</bdi></span>
      <Button size="icon-xs" variant="ghost" disabled={!canMoveUp} aria-label={`Move ${entry.name} up`} onClick={() => onMove(-1)}>
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button size="icon-xs" variant="ghost" disabled={!canMoveDown} aria-label={`Move ${entry.name} down`} onClick={() => onMove(1)}>
        <ArrowDown className="h-4 w-4" />
      </Button>
    </div>
  );
}
