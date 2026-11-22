import { useMemo, useState } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, ChevronUp, GripVertical, Pin, PinOff, X } from 'lucide-react'
import { Artwork } from '@/components/ui'
import { cn } from '@/lib/utils'
import type { Actor, QueueItem } from '@/domain/types'
import type { RoomCommand } from '@/server/commands'
import { formatTime, showRemove } from './view-model'

interface QueueListProps {
  items: QueueItem[]
  history: QueueItem[]
  actor?: Actor
  myVotes: Set<string>
  queueRevision: number
  run: (cmd: RoomCommand) => Promise<unknown>
  onFindSongs?: () => void
}

function VoteButton({ item, voted, run }: { item: QueueItem; voted: boolean; run: QueueListProps['run'] }) {
  return (
    <button
      type="button"
      aria-pressed={voted}
      aria-label={`${voted ? 'Remove your vote for' : 'Vote for'} ${item.title}, ${item.voteCount} ${item.voteCount === 1 ? 'vote' : 'votes'}`}
      onClick={() => run({ type: voted ? 'unvote' : 'vote', itemId: item.id })}
      className={cn(
        'inline-flex h-8 min-w-12 items-center justify-center gap-1 rounded-full border px-2.5 text-xs font-semibold tabular-nums transition-colors',
        voted ? 'border-primary text-primary' : 'border-input text-muted-foreground hover:text-foreground',
      )}
    >
      <ChevronUp className="size-3.5" aria-hidden />
      {item.voteCount}
    </button>
  )
}

interface RowProps {
  item: QueueItem
  index: number
  total: number
  actor?: Actor
  voted: boolean
  run: QueueListProps['run']
  onMove: (item: QueueItem, dir: -1 | 1) => void
  sortable: boolean
}

function Row({ item, index, total, actor, voted, run, onMove, sortable }: RowProps) {
  const isHost = actor?.role === 'host'
  const s = useSortable({ id: item.id, disabled: !sortable })
  const style = { transform: CSS.Transform.toString(s.transform), transition: s.transition }
  const mine = item.requestedByMemberId === actor?.memberId
  return (
    <li
      ref={s.setNodeRef}
      style={style}
      className={cn('grid grid-cols-[1.5rem_44px_minmax(0,1fr)_auto] items-center gap-3 py-2.5', s.isDragging && 'relative z-10 rounded-lg bg-card shadow-lg')}
    >
      {sortable ? (
        <button
          type="button"
          {...s.attributes}
          {...s.listeners}
          aria-label={`Drag to reorder ${item.title}`}
          className="grid h-8 cursor-grab place-items-center rounded text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      ) : (
        <span className="text-right text-sm tabular-nums text-muted-foreground">{index + 1}</span>
      )}
      <Artwork src={item.thumbnailUrl} title={item.title} className="w-11" />
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{item.title}</p>
        <p className="truncate text-sm text-muted-foreground">
          {item.pinnedAt !== null && <span className="text-primary">Plays next · </span>}
          {mine ? 'you' : item.requestedByName}
          {item.durationMs ? ` · ${formatTime(item.durationMs / 1000)}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <VoteButton item={item} voted={voted} run={run} />
        {isHost && item.pinnedAt === null && (
          <span className="hidden gap-1 sm:flex">
            <button type="button" aria-label={`Move ${item.title} up`} disabled={index === 0} onClick={() => onMove(item, -1)} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30">
              <ArrowUp className="size-4" aria-hidden />
            </button>
            <button type="button" aria-label={`Move ${item.title} down`} disabled={index === total - 1} onClick={() => onMove(item, 1)} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30">
              <ArrowDown className="size-4" aria-hidden />
            </button>
          </span>
        )}
        {isHost && (
          <button
            type="button"
            aria-label={item.pinnedAt !== null ? `Unpin ${item.title}` : `Play ${item.title} next`}
            onClick={() => run({ type: item.pinnedAt !== null ? 'unpin' : 'pin', itemId: item.id })}
            className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {item.pinnedAt !== null ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}
          </button>
        )}
        {showRemove(actor, item) && (
          <button type="button" aria-label={`Remove ${item.title}`} onClick={() => run({ type: 'remove', itemId: item.id })} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-destructive">
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
    </li>
  )
}

export function QueueList({ items, history, actor, myVotes, queueRevision, run, onFindSongs }: QueueListProps) {
  const [mineOnly, setMineOnly] = useState(false)
  const isHost = actor?.role === 'host'
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const visible = useMemo(() => (mineOnly ? items.filter((i) => i.requestedByMemberId === actor?.memberId) : items), [items, mineOnly, actor?.memberId])
  const unpinned = items.filter((i) => i.pinnedAt === null)
  const mineCount = items.filter((i) => i.requestedByMemberId === actor?.memberId).length

  function reorderTo(itemId: string, list: QueueItem[], newIndex: number) {
    const others = list.filter((i) => i.id !== itemId)
    const before = others[newIndex - 1]?.id ?? null
    const after = others[newIndex]?.id ?? null
    void run({ type: 'reorder', itemId, beforeId: before, afterId: after, expectedQueueRevision: queueRevision })
  }

  function onMove(item: QueueItem, dir: -1 | 1) {
    const idx = unpinned.findIndex((i) => i.id === item.id)
    if (idx < 0) return
    reorderTo(item.id, unpinned, idx + dir)
  }

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return
    const from = unpinned.findIndex((i) => i.id === e.active.id)
    const to = unpinned.findIndex((i) => i.id === e.over?.id)
    if (from < 0 || to < 0) return
    const moved = arrayMove(unpinned, from, to)
    reorderTo(String(e.active.id), moved, to)
  }

  const canSort = isHost && !mineOnly

  return (
    <section aria-labelledby="queue-heading" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="queue-heading" className="text-base font-semibold text-foreground">
          Up next <span className="font-normal text-muted-foreground">{items.length === 1 ? '1 song' : `${items.length} songs`}</span>
        </h2>
        {mineCount > 0 && (
          <button
            type="button"
            aria-pressed={mineOnly}
            onClick={() => setMineOnly((v) => !v)}
            className={cn('rounded-full border px-3 py-1 text-xs font-semibold transition-colors', mineOnly ? 'border-primary text-primary' : 'border-input text-muted-foreground hover:text-foreground')}
          >
            Mine ({mineCount})
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="grid gap-3 rounded-xl border border-dashed border-border p-6">
          <p className="text-foreground">The queue is empty.</p>
          <p className="text-sm text-muted-foreground">Add the first song. Everyone in the room will see it right away.</p>
          {onFindSongs && (
            <button type="button" onClick={onFindSongs} className="w-fit rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              Find a song
            </button>
          )}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={unpinned.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ol className="divide-y divide-border">
              {visible.map((item, index) => (
                <Row
                  key={item.id}
                  item={item}
                  index={index}
                  total={visible.length}
                  actor={actor}
                  voted={myVotes.has(item.id)}
                  run={run}
                  onMove={onMove}
                  sortable={canSort && item.pinnedAt === null}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {history.length > 0 && (
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-sm font-semibold text-muted-foreground hover:text-foreground">
            Recently played <span className="font-normal">({history.length})</span>
          </summary>
          <ol className="mt-2 divide-y divide-border">
            {history.map((item) => (
              <li key={item.id} className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-3 py-2 opacity-80">
                <Artwork src={item.thumbnailUrl} title={item.title} className="w-11" />
                <div className="min-w-0">
                  <p className="truncate text-foreground">{item.title}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {item.status === 'played' ? 'Played' : item.status === 'skipped' ? 'Skipped' : (item.failureReason ?? "Couldn't play")}
                    {' · '}
                    {item.requestedByName}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}
