import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { StatusSection } from '@/components/chat/status-section'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { type Translations, useI18n } from '@/i18n'
import { CornerDownLeft, iconSize, Pencil, SteeringWheel } from '@/lib/icons'
import { MINUTE, relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import {
  $queuedDeliveriesByTarget,
  type QueuedDeliveryRow,
  type QueuedDeliverySessionOwner,
  type QueuedDeliveryStatus,
  selectQueuedDeliveriesForSession
} from '@/plugins/hermes-bots/queued-deliveries'
import { isSteerableEntry, type QueuedPromptEntry } from '@/store/composer-queue'

interface QueuePanelProps {
  /** Owner the chat on screen resolves to; its bot is the delivery lane this
   *  panel shows. Absent for a draft or an owner that is not known yet. */
  botSessionOwner?: null | QueuedDeliverySessionOwner | string
  busy: boolean
  editingId: null | string
  entries: QueuedPromptEntry[]
  onDelete: (id: string) => void
  /** Acknowledge a turn the gateway lost across a restart (`unknown` row) so
   *  the queued turns behind it flow again. Absent on non-canonical hosts. */
  onDiscardLost?: (id: string) => void
  onEdit: (entry: QueuedPromptEntry) => void
  /** Lift a park (explicit Stop/Esc halt) and let the queue flow again. */
  onResume: () => void
  onSendNow: (id: string) => void
  /** Deliver an entry as a mid-turn redirect (no interrupt). Absent when the
   *  host has no steer path — the affordance hides rather than dead-clicks. */
  onSteerNow?: (id: string) => void
  /** True after an explicit halt: entries wait until resumed / sent / edited. */
  parked: boolean
}

/** A row of the one FIFO the panel shows: the owner's own queued turn, or a
 *  bot-to-bot delivery the relay is holding for this bot. */
type PanelRow = { delivery: QueuedDeliveryRow; kind: 'bot' } | { entry: QueuedPromptEntry; kind: 'prompt' }

/** A bot delivery stuck behind a busy target for longer than this says so. */
const STUCK_AFTER_MS = 2 * MINUTE
/** Re-read the clock while a delivery waits, so the stuck hint appears on its own. */
const AGE_TICK_MS = 30_000

const rowQueuedAt = (row: PanelRow) => (row.kind === 'bot' ? row.delivery.queuedAt : row.entry.queuedAt)

const entryPreview = (entry: QueuedPromptEntry, c: Translations['composer']) =>
  entry.displayKind === 'hidden'
    ? c.hiddenQueued
    : (entry.displayText ?? entry.text).trim() || (entry.attachments.length > 0 ? c.attachmentOnly : c.emptyTurn)

/** A preview long enough (or multiline enough) that two lines may still hide
 *  part of it — the entry gets an in-place expand/collapse toggle (#45664). */
const shouldOfferExpandedPreview = (preview: string) => preview.length > 140 || preview.includes('\n')

/** The bot attribution a server-owned row carries. A row without one renders
 *  exactly as before (the plain comment glyph). */
const serverAuthorLabel = (entry: QueuedPromptEntry, c: Translations['composer']) =>
  entry.author ? entry.author.name?.trim() || c.queueBotFallback : ''

const deliveryStatusLabel = (status: QueuedDeliveryStatus, c: Translations['composer']) =>
  status === 'delivering' ? c.queueBotDelivering : status === 'failed' ? c.queueBotFailed : c.queueBotQueued

const deliveryStatusTone = (status: QueuedDeliveryStatus) =>
  status === 'failed' ? 'text-destructive' : status === 'delivering' ? 'text-sky-600' : 'text-muted-foreground/70'

export function QueuePanel({
  botSessionOwner,
  busy,
  editingId,
  entries,
  onDelete,
  onDiscardLost,
  onEdit,
  onResume,
  onSendNow,
  onSteerNow,
  parked
}: QueuePanelProps) {
  const { t } = useI18n()
  const c = t.composer
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())
  // Bumped on a timer while a delivery waits, so the stuck hint's age re-renders.
  const [, setAgeTick] = useState(0)
  // Bot deliveries the relay holds for THIS chat's bot, in claim order.
  const deliveries = useStore($queuedDeliveriesByTarget)
  const botRows = selectQueuedDeliveriesForSession(deliveries, botSessionOwner)
  const waitingCount = botRows.filter(delivery => delivery.status !== 'failed').length

  // The stuck hint is time-based: re-read the clock while anything waits so a
  // silently parked delivery becomes visible without another store write.
  useEffect(() => {
    if (waitingCount === 0) {
      return
    }

    const timer = setInterval(() => setAgeTick(tick => tick + 1), AGE_TICK_MS)

    return () => clearInterval(timer)
  }, [waitingCount])

  const toggleExpanded = (id: string) => {
    setExpandedIds(current => {
      const next = new Set(current)

      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }

      return next
    })
  }

  const renderExpand = (id: string, preview: string) => {
    if (!shouldOfferExpandedPreview(preview)) {
      return null
    }

    const isExpanded = expandedIds.has(id)

    return (
      <Tip label={isExpanded ? c.queueCollapse : c.queueExpand}>
        <Button
          aria-expanded={isExpanded}
          aria-label={isExpanded ? c.queueCollapse : c.queueExpand}
          className="size-5 rounded-md"
          onClick={() => toggleExpanded(id)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Codicon
            className={cn('transition-transform', isExpanded && 'rotate-180')}
            name="chevron-down"
            size={iconSize.xs}
          />
        </Button>
      </Tip>
    )
  }

  // A bot delivery is not the owner's to edit, delete, steer or reorder: the
  // row shows the same preview treatment and nothing else. Its attribution is
  // the sender bot (robot glyph + name) in place of the user's own avatar.
  const renderBotRow = (delivery: QueuedDeliveryRow) => {
    const preview = delivery.text.trim() || c.emptyTurn
    const isExpanded = expandedIds.has(delivery.id)
    const now = Date.now()
    // A row still waiting (queued, or delivering with no answer yet) past the
    // threshold says so — a silent lane is exactly what this panel is for.
    const stuck = delivery.status !== 'failed' && now - delivery.queuedAt > STUCK_AFTER_MS
    const sender = delivery.senderName || delivery.senderHandle || c.queueBotFallback

    return (
      <StatusRow
        key={delivery.id}
        leading={<Codicon className="text-muted-foreground/70" name="robot" size="0.8rem" />}
        trailing={renderExpand(delivery.id, preview)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className="truncate text-[0.64rem] font-medium text-muted-foreground/85"
              data-slot="queue-author"
              title={c.queueBotAuthor(sender)}
            >
              {sender}
            </span>
            <span
              className={cn(
                'shrink-0 text-[0.6rem] uppercase leading-3 tracking-wide',
                deliveryStatusTone(delivery.status)
              )}
              data-slot="queue-bot-status"
              title={delivery.status === 'failed' ? delivery.lastError : undefined}
            >
              {deliveryStatusLabel(delivery.status, c)}
            </span>
          </div>
          <p
            className={cn(
              'text-[0.73rem] leading-4 text-foreground/92',
              isExpanded ? 'max-h-40 overflow-y-auto whitespace-pre-wrap pr-1' : 'line-clamp-2 break-words'
            )}
          >
            {preview}
          </p>
          {stuck && (
            <div className="mt-0.5 text-[0.64rem] text-amber-600" data-slot="queue-bot-stuck">
              {c.queueBotStuck(relativeTime(delivery.queuedAt, now))}
            </div>
          )}
          {delivery.status === 'failed' && delivery.lastError && (
            <div className="mt-0.5 truncate text-[0.64rem] text-destructive/80" data-slot="queue-bot-error">
              {delivery.lastError}
            </div>
          )}
        </div>
      </StatusRow>
    )
  }

  const renderPromptRow = (entry: QueuedPromptEntry) => {
    const isEditing = editingId === entry.id
    const attachmentsCount = entry.attachments.length

    // Steer only surfaces where it can actually deliver: a live turn to
    // redirect and an entry the redirect can carry (text-only, no slash).
    // A server row can be steered only when its owner serves the verb for it.
    const canSteer =
      busy &&
      Boolean(onSteerNow) &&
      (entry.serverStatus ? Boolean(entry.serverControls?.includes('steer')) : isSteerableEntry(entry))

    // The owner died mid-turn and recovered this row as `unknown`: the
    // FIFO behind it is paused until someone acknowledges the loss.
    const lost = entry.serverStatus === 'unknown'
    const preview = entryPreview(entry, c)
    const isExpanded = expandedIds.has(entry.id)
    const author = serverAuthorLabel(entry, c)

    return (
      <StatusRow
        className={cn(
          isEditing &&
            'ring-1 ring-inset ring-[color-mix(in_srgb,var(--dt-composer-ring)_40%,transparent)] bg-accent/25'
        )}
        dismiss={{ label: c.queueDelete, onDismiss: () => onDelete(entry.id) }}
        key={entry.id}
        leading={<Codicon className="text-muted-foreground/70" name={author ? 'robot' : 'comment'} size="0.8rem" />}
        trailing={
          <>
            {renderExpand(entry.id, preview)}
            {renderEntryActions({
              busy,
              c,
              editingId,
              entry,
              isEditing,
              lost,
              onDiscardLost,
              onEdit,
              onSendNow,
              onSteerNow,
              canSteer
            })}
          </>
        }
        trailingVisible={isEditing || lost}
      >
        <div className="min-w-0 flex-1">
          {author && (
            <div className="flex min-w-0 items-center gap-1.5" data-slot="queue-author">
              <span className="truncate text-[0.64rem] font-medium text-muted-foreground/85">{author}</span>
            </div>
          )}
          <p
            className={cn(
              'text-[0.73rem] leading-4 text-foreground/92',
              isExpanded ? 'max-h-40 overflow-y-auto whitespace-pre-wrap pr-1' : 'line-clamp-2 break-words'
            )}
          >
            {preview}
          </p>
          {(attachmentsCount > 0 || isEditing || lost) && (
            <div className="mt-0.5 flex items-center gap-1.5 text-[0.64rem] text-muted-foreground/75">
              {lost && <span data-slot="queue-lost-note">{c.queueLostNote}</span>}
              {attachmentsCount > 0 && <span>{c.attachments(attachmentsCount)}</span>}
              {isEditing && (
                <span className="text-[color-mix(in_srgb,var(--dt-composer-ring)_78%,var(--muted-foreground))]">
                  {c.editingInComposer}
                </span>
              )}
            </div>
          )}
        </div>
      </StatusRow>
    )
  }

  // One FIFO: the owner's queued turns and the bot deliveries held for this bot,
  // oldest first. A delivery claimed before a prompt sits above it, as it will
  // reach the target.
  const rows: PanelRow[] = [
    ...entries.map(entry => ({ entry, kind: 'prompt' as const })),
    ...botRows.map(delivery => ({ delivery, kind: 'bot' as const }))
  ].sort((a, b) => rowQueuedAt(a) - rowQueuedAt(b))

  if (rows.length === 0) {
    return null
  }

  const renderRow = (row: PanelRow) => (row.kind === 'bot' ? renderBotRow(row.delivery) : renderPromptRow(row.entry))

  // A lost (`unknown`) turn pauses the FIFO until someone acknowledges it: its card and Discard
  // must be on screen without expanding the section, and the header names the pause (#134889 NF2).
  const lostEntries = entries.filter(entry => entry.serverStatus === 'unknown')
  const paused = parked || lostEntries.length > 0

  return (
    <StatusSection
      accessory={
        parked ? (
          <Tip label={c.queueResumeTip}>
            <Button
              className="text-muted-foreground/75 hover:text-foreground/90"
              onClick={onResume}
              size="micro"
              type="button"
              variant="text"
            >
              {c.queueResume}
            </Button>
          </Tip>
        ) : undefined
      }
      icon={<Codicon className="text-muted-foreground/70" name={paused ? 'debug-pause' : 'layers'} size="0.8rem" />}
      label={paused ? c.queuedPaused(rows.length) : c.queued(rows.length)}
      preview={lostEntries.length > 0 ? lostEntries.map(entry => renderPromptRow(entry)) : undefined}
    >
      {rows.map(renderRow)}
    </StatusSection>
  )
}

interface EntryActionsArgs {
  busy: boolean
  c: Translations['composer']
  canSteer: boolean
  editingId: null | string
  entry: QueuedPromptEntry
  isEditing: boolean
  lost: boolean
  onDiscardLost?: (id: string) => void
  onEdit: (entry: QueuedPromptEntry) => void
  onSendNow: (id: string) => void
  onSteerNow?: (id: string) => void
}

/** Per-row trailing actions: discard for a lost row, else edit/steer/send for a local one. A
 *  server row gets only the edit/steer its owner serves, never send-next: reordering it would
 *  break the owner's one FIFO. */
function renderEntryActions({
  busy,
  c,
  canSteer,
  editingId,
  entry,
  isEditing,
  lost,
  onDiscardLost,
  onEdit,
  onSendNow,
  onSteerNow
}: EntryActionsArgs) {
  return lost && onDiscardLost ? (
    <Tip label={c.queueLostDiscardTip}>
      <Button
        aria-label={c.queueLostDiscard}
        className="h-5 rounded-md px-1.5 text-[0.66rem]"
        data-slot="queue-lost-discard"
        onClick={() => onDiscardLost(entry.id)}
        size="micro"
        type="button"
        variant="text"
      >
        {c.queueLostDiscard}
      </Button>
    </Tip>
  ) : (
    <>
      {(!entry.serverStatus || entry.serverControls?.includes('replace')) && (
        <Tip label={c.queueEdit}>
          <Button
            aria-label={c.queueEdit}
            className="size-5 rounded-md"
            disabled={Boolean(editingId) && !isEditing}
            onClick={() => onEdit(entry)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Pencil className={iconSize.xs} />
          </Button>
        </Tip>
      )}
      {canSteer && (
        <Tip label={c.queueSteer}>
          <Button
            aria-label={c.queueSteer}
            className="size-5 rounded-md"
            disabled={isEditing}
            onClick={() => onSteerNow?.(entry.id)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <SteeringWheel className={iconSize.xs} />
          </Button>
        </Tip>
      )}
      {!entry.serverStatus && (
        <Tip label={busy ? c.queueSendNext : c.queueSend}>
          <Button
            aria-label={busy ? c.queueSendNext : c.queueSend}
            className="size-5 rounded-md"
            disabled={isEditing}
            onClick={() => onSendNow(entry.id)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <CornerDownLeft className={iconSize.xs} />
          </Button>
        </Tip>
      )}
    </>
  )
}
