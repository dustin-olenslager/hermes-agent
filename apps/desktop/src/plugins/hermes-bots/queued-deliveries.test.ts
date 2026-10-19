import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  $queuedDeliveriesByTarget,
  clearQueuedDeliveries,
  failDelivery,
  markDelivering,
  noteQueuedDelivery,
  queuedDeliveryTargetKey,
  selectQueuedDeliveriesForSession,
  settleDelivery
} from './queued-deliveries'

afterEach(() => {
  vi.useRealTimers()
  clearQueuedDeliveries()
})

const notice = (overrides: Partial<Parameters<typeof noteQueuedDelivery>[0]> = {}) => ({
  id: 'dlv-1',
  senderHandle: '@ada',
  senderName: 'ada',
  targetConnection: 'local',
  targetProfile: 'bob',
  text: 'hello bob',
  ...overrides
})

const rowsFor = (key = 'local::bob') => $queuedDeliveriesByTarget.get()[key] ?? []

describe('queued delivery store', () => {
  it('keys a target by connection + normalized profile, and refuses an empty profile', () => {
    expect(queuedDeliveryTargetKey('local', '  Bob ')).toBe('local::bob')
    expect(queuedDeliveryTargetKey(undefined, 'bob')).toBe('::bob')
    expect(queuedDeliveryTargetKey('local', '   ')).toBeNull()
  })

  it('holds one queued row per claimed delivery', () => {
    noteQueuedDelivery(notice())

    expect(rowsFor()).toEqual([
      expect.objectContaining({
        attempts: 0,
        id: 'dlv-1',
        senderHandle: '@ada',
        senderName: 'ada',
        status: 'queued',
        targetProfile: 'bob',
        text: 'hello bob'
      })
    ])
  })

  it('is idempotent on re-claim: age and attempts survive a later drain', () => {
    noteQueuedDelivery(notice())
    const [first] = rowsFor()
    markDelivering('dlv-1')
    noteQueuedDelivery(notice({ text: 'hello again' }))

    const [again] = rowsFor()
    expect(again?.queuedAt).toBe(first?.queuedAt)
    expect(again?.attempts).toBe(1)
    expect(again?.status).toBe('delivering')
    expect(again?.text).toBe('hello again')
  })

  it('counts attempts and shows the delivery moving', () => {
    noteQueuedDelivery(notice())
    markDelivering('dlv-1')

    expect(rowsFor()[0]).toEqual(expect.objectContaining({ attempts: 1, status: 'delivering' }))
  })

  it('keeps a retryable refusal visible as failed, with its reason', () => {
    noteQueuedDelivery(notice())
    markDelivering('dlv-1')
    failDelivery('dlv-1', 'runtime_unavailable')

    expect(rowsFor()[0]).toEqual(expect.objectContaining({ lastError: 'runtime_unavailable', status: 'failed' }))

    // The relay retrying the pinned envelope puts it back in the queue.
    noteQueuedDelivery(notice())
    expect(rowsFor()[0]?.status).toBe('queued')
  })

  it('drops the row once the delivery settles', () => {
    noteQueuedDelivery(notice())
    settleDelivery('dlv-1')

    expect($queuedDeliveriesByTarget.get()).toEqual({})
  })

  it('selects the rows waiting on one session owner, oldest first', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    noteQueuedDelivery(notice({ id: 'earlier' }))
    vi.setSystemTime(2_000)
    noteQueuedDelivery(notice({ id: 'later' }))
    vi.setSystemTime(3_000)
    noteQueuedDelivery(notice({ id: 'elsewhere', targetConnection: 'remote-1', targetProfile: 'bob' }))
    noteQueuedDelivery(notice({ id: 'other-bot', targetProfile: 'carol' }))

    const rows = selectQueuedDeliveriesForSession($queuedDeliveriesByTarget.get(), {
      connectionId: 'local',
      profile: 'bob'
    })

    expect(rows.map(row => row.id)).toEqual(['earlier', 'later'])
  })

  it('prefers a route-pinned target profile over the owner profile name', () => {
    noteQueuedDelivery(notice())

    const rows = selectQueuedDeliveriesForSession($queuedDeliveriesByTarget.get(), {
      connectionId: 'local',
      profile: 'gateway-default',
      targetProfile: 'bob'
    })

    expect(rows.map(row => row.id)).toEqual(['dlv-1'])
  })

  it('matches a bare profile owner across the connections that host it', () => {
    noteQueuedDelivery(notice({ id: 'here' }))
    noteQueuedDelivery(notice({ id: 'there', targetConnection: 'remote-1' }))

    const rows = selectQueuedDeliveriesForSession($queuedDeliveriesByTarget.get(), 'BOB')

    expect(rows.map(row => row.id).sort()).toEqual(['here', 'there'])
  })

  it('returns nothing for an unknown owner', () => {
    noteQueuedDelivery(notice())

    expect(selectQueuedDeliveriesForSession($queuedDeliveriesByTarget.get(), undefined)).toEqual([])
    expect(selectQueuedDeliveriesForSession($queuedDeliveriesByTarget.get(), { profile: 'nobody' })).toEqual([])
  })
})
