/**
 * Bot-to-bot deliveries the relay is holding for one target bot.
 *
 * `relay.ts` claims envelopes from every gateway's outbox and keeps them in
 * renderer memory until the target connection answers (or the sender gateway
 * ACKs). That hold IS a queue, but until now nothing rendered it: a delivery
 * stuck behind a busy target looked exactly like silence. This atom is its
 * presentation mirror — one row per held envelope, keyed by the TARGET bot.
 *
 * Display-only by construction: the relay's claim/deliver/retry path calls
 * these note/mark/settle/fail hooks, and nothing here can answer, reorder or
 * retry a delivery. Rows live in memory only; a renderer restart re-populates
 * them from the sender's durable claimed directory on the next drain.
 */

import { atom } from 'nanostores'

export type QueuedDeliveryStatus = 'delivering' | 'failed' | 'queued'

/** One held bot delivery, as the composer's queue panel shows it. */
export interface QueuedDeliveryRow {
  /** Delivery attempts observed since the row first appeared. */
  attempts: number
  id: string
  /** Last retryable refusal, kept on a `failed` row so the reason stays visible. */
  lastError?: string
  queuedAt: number
  /** Sender profile name (`from_profile`), the bot a human recognizes. */
  senderName: string
  /** Sender handle (`from_handle`), the fallback when no profile name is known. */
  senderHandle: string
  status: QueuedDeliveryStatus
  /** Connection the target bot lives on (`target_connection`). */
  targetConnection: string
  /** Profile name of the target bot (`target_profile`). */
  targetProfile: string
  /** The message being delivered (`envelope.message`). */
  text: string
}

/** What a claim tells the store about one envelope. */
export interface QueuedDeliveryNotice {
  id: string
  senderHandle?: string
  senderName?: string
  targetConnection?: string
  targetProfile?: string
  text?: string
}

/** The owner scope a bot session resolves to (`knownOwnerForSession`). */
export interface QueuedDeliverySessionOwner {
  connectionId?: string
  profile?: string
}

/** Target key -> FIFO rows for that target, oldest claim first. */
export const $queuedDeliveriesByTarget = atom<Record<string, QueuedDeliveryRow[]>>({})

const EMPTY: QueuedDeliveryRow[] = []

/**
 * One key per target bot. The connection qualifies the profile because two
 * connected gateways can both host a `default` — the same collision the
 * session-owner ladder guards against elsewhere.
 */
export function queuedDeliveryTargetKey(
  connectionId: null | string | undefined,
  profile: null | string | undefined
): null | string {
  const name = String(profile ?? '')
    .trim()
    .toLowerCase()

  if (!name) {
    return null
  }

  return `${String(connectionId ?? '').trim()}::${name}`
}

const text = (value: unknown) => String(value ?? '').trim()

/**
 * Record (or refresh) one claimed envelope. Idempotent by delivery id: a later
 * drain re-queues every pinned envelope, and that must not reset the row's age
 * or attempt count. A previously `failed` row returns to `queued` because the
 * relay is trying it again.
 */
export function noteQueuedDelivery(notice: QueuedDeliveryNotice): void {
  const id = text(notice.id)

  if (!id) {
    return
  }

  const targetConnection = text(notice.targetConnection)
  const targetProfile = text(notice.targetProfile)
  const key = queuedDeliveryTargetKey(targetConnection, targetProfile)

  if (!key) {
    return
  }

  const all = $queuedDeliveriesByTarget.get()
  const rows = all[key] ?? []
  const index = rows.findIndex(row => row.id === id)
  const held = rows[index]

  const next: QueuedDeliveryRow = held
    ? {
        ...held,
        ...(notice.senderHandle ? { senderHandle: text(notice.senderHandle) } : {}),
        ...(notice.senderName ? { senderName: text(notice.senderName) } : {}),
        ...(notice.text !== undefined ? { text: String(notice.text) } : {}),
        status: held.status === 'failed' ? 'queued' : held.status
      }
    : {
        attempts: 0,
        id,
        queuedAt: Date.now(),
        senderHandle: text(notice.senderHandle),
        senderName: text(notice.senderName),
        status: 'queued',
        targetConnection,
        targetProfile,
        text: String(notice.text ?? '')
      }

  const nextRows = held ? rows.map((row, at) => (at === index ? next : row)) : [...rows, next]

  $queuedDeliveriesByTarget.set({ ...all, [key]: nextRows })
}

/** Rewrite one row wherever it lives, dropping it when `update` returns null. */
const updateRow = (id: string, update: (row: QueuedDeliveryRow) => null | QueuedDeliveryRow): void => {
  const all = $queuedDeliveriesByTarget.get()
  let changed = false
  const next: Record<string, QueuedDeliveryRow[]> = {}

  for (const [key, rows] of Object.entries(all)) {
    let touched = false

    const mapped = rows.flatMap(row => {
      if (row.id !== id) {
        return [row]
      }

      touched = true

      const updated = update(row)

      return updated ? [updated] : []
    })

    if (touched) {
      changed = true

      if (mapped.length > 0) {
        next[key] = mapped
      }
    } else {
      next[key] = rows
    }
  }

  if (changed) {
    $queuedDeliveriesByTarget.set(next)
  }
}

/** The relay started delivering this envelope: count the attempt, show the state. */
export function markDelivering(id: string): void {
  updateRow(text(id), row => ({ ...row, attempts: row.attempts + 1, status: 'delivering' }))
}

/** The delivery reached a terminal receipt: the row is no longer waiting. */
export function settleDelivery(id: string): void {
  updateRow(text(id), () => null)
}

/**
 * A retryable refusal (transport error, lost identity, unknown outcome): the
 * envelope stays pinned for the relay's next attempt, and its row STAYS visible
 * as `failed` with the reason — the stuck queue is the whole point.
 */
export function failDelivery(id: string, reason: unknown): void {
  const lastError = text(reason).slice(0, 200)

  updateRow(text(id), row => ({ ...row, ...(lastError ? { lastError } : {}), status: 'failed' }))
}

/** Drop every row — relay teardown, or a test reset. */
export function clearQueuedDeliveries(): void {
  if (Object.keys($queuedDeliveriesByTarget.get()).length > 0) {
    $queuedDeliveriesByTarget.set({})
  }
}

/**
 * Rows waiting on the bot behind `owner`, oldest claim first. A bare profile
 * scope (a legacy local owner with no connection id) matches every connection
 * that hosts that profile rather than guessing one.
 */
export function selectQueuedDeliveriesForSession(
  deliveries: Record<string, QueuedDeliveryRow[]>,
  owner: null | QueuedDeliverySessionOwner | string | undefined
): QueuedDeliveryRow[] {
  if (!owner) {
    return EMPTY
  }

  const profile = text(typeof owner === 'string' ? owner : owner.profile).toLowerCase()

  if (!profile) {
    return EMPTY
  }

  if (typeof owner === 'string' || !owner.connectionId) {
    return Object.values(deliveries)
      .flat()
      .filter(row => row.targetProfile.trim().toLowerCase() === profile)
      .sort((a, b) => a.queuedAt - b.queuedAt)
  }

  return deliveries[queuedDeliveryTargetKey(owner.connectionId, profile) ?? ''] ?? EMPTY
}
