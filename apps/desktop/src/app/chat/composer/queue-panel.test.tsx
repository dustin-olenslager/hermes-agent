import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { en } from '@/i18n/en'
import { MINUTE, relativeTime } from '@/lib/time'
import {
  $queuedDeliveriesByTarget,
  clearQueuedDeliveries,
  failDelivery,
  markDelivering,
  type QueuedDeliveryRow,
  settleDelivery
} from '@/plugins/hermes-bots/queued-deliveries'
import type { QueuedPromptEntry } from '@/store/composer-queue'

import { QueuePanel } from './queue-panel'

const entry = (id: string, text: string): QueuedPromptEntry => ({
  attachments: [],
  id,
  queuedAt: Date.now(),
  text
})

/** The bot chat on screen: its bot (`bob`) is the delivery lane under test. */
const owner = { connectionId: 'local', profile: 'bob' }

const deliveryRow = (overrides: Partial<QueuedDeliveryRow> = {}): QueuedDeliveryRow => ({
  attempts: 0,
  id: 'dlv-1',
  queuedAt: Date.now(),
  senderHandle: '@ada',
  senderName: 'ada',
  status: 'queued',
  targetConnection: 'local',
  targetProfile: 'bob',
  text: 'bot words',
  ...overrides
})

const seedDelivery = (row: QueuedDeliveryRow = deliveryRow()) =>
  $queuedDeliveriesByTarget.set({ 'local::bob': [row] })

type PanelProps = Parameters<typeof QueuePanel>[0]

function renderPanel(entries: QueuedPromptEntry[], overrides: Partial<PanelProps> = {}) {
  return render(
    <I18nProvider configClient={{ getConfig: async () => ({}), saveConfig: async () => ({ ok: true }) }}>
      <QueuePanel
        botSessionOwner={owner}
        busy={false}
        editingId={null}
        entries={entries}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onResume={vi.fn()}
        onSendNow={vi.fn()}
        parked={false}
        {...overrides}
      />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  clearQueuedDeliveries()
})

// The panel's StatusSection starts collapsed; tests read the entries, so open it.
async function renderExpandedPanel(entries: QueuedPromptEntry[], overrides: Partial<PanelProps> = {}) {
  const view = renderPanel(entries, overrides)

  fireEvent.click(await view.findByRole('button', { name: /queued/i }))

  return view
}

const rowOf = (text: string) => screen.getByText(text).closest('[data-slot="status-row"]') as HTMLElement

const rowButtons = (row: HTMLElement) =>
  within(row)
    .queryAllByRole('button')
    .map(button => button.getAttribute('aria-label'))
    .filter(Boolean)

// #45664: a long queued prompt was only ever readable as one truncated line
// (or by loading it back into the composer). Long and multiline previews now
// carry an expand/collapse toggle that reveals the full text in place.
describe('QueuePanel expandable previews', () => {
  it('offers expansion for long and multiline entries but not short ones', async () => {
    await renderExpandedPanel([
      entry('short', 'Quick note'),
      entry('long', 'A'.repeat(200)),
      entry('multiline', 'First line\nSecond line')
    ])

    await screen.findByText('Quick note')

    // Exactly the two long/multiline entries get a toggle, not the short one.
    expect(screen.getAllByRole('button', { name: /expand/i })).toHaveLength(2)
  })

  it('expands an entry to its full text and collapses it back', async () => {
    const text = `${'A'.repeat(200)}\nlast line`
    await renderExpandedPanel([entry('long', text)])

    // The DOM keeps the newline in textContent; findByText normalizes
    // whitespace, so locate the <p> by exact textContent instead.
    expect(
      await screen.findByText((_, element) => element?.tagName === 'P' && element.textContent === text)
    ).toBeTruthy()

    const toggle = screen.getByRole('button', { name: /expand/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    const collapse = screen.getByRole('button', { name: /collapse/i })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(collapse)
    expect(screen.getByRole('button', { name: /expand/i }).getAttribute('aria-expanded')).toBe('false')
  })
})

// #134889 NF2: after the gateway is killed mid-turn, owner recovery fences the turn `unknown` and
// pauses the FIFO behind it. The Discard choice lived inside the collapsed queue section, so the
// chat showed only "1 Queued" (then "2 Queued" for a follow-up) with no reason and no action.
describe('QueuePanel lost turn', () => {
  it('shows the lost turn and its Discard without expanding, and names the pause', async () => {
    const onDiscardLost = vi.fn()
    renderPanel([{ ...entry('lost', 'doomed turn'), serverStatus: 'unknown' }, entry('next', 'follow up')], {
      onDiscardLost
    })

    expect(await screen.findByText('Turn lost during restart')).toBeTruthy()
    expect(screen.getByRole('button', { name: /2 queued — paused/i })).toBeTruthy()
    // Only the lost row is previewed while collapsed; the healthy follow-up stays inside the section.
    expect(screen.queryByText('follow up')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDiscardLost).toHaveBeenCalledWith('lost')
  })

  it('opens when a queued row turns lost after the panel mounted', async () => {
    const view = renderPanel([entry('a', 'first')])
    expect(view.queryByText('Turn lost during restart')).toBeNull()
    view.rerender(
      <I18nProvider configClient={{ getConfig: async () => ({}), saveConfig: async () => ({ ok: true }) }}>
        <QueuePanel
          botSessionOwner={owner}
          busy={false}
          editingId={null}
          entries={[{ ...entry('a', 'first'), serverStatus: 'unknown' }]}
          onDelete={vi.fn()}
          onDiscardLost={vi.fn()}
          onEdit={vi.fn()}
          onResume={vi.fn()}
          onSendNow={vi.fn()}
          parked={false}
        />
      </I18nProvider>
    )
    expect(await screen.findByText('Turn lost during restart')).toBeTruthy()
  })
})

// Bot-to-bot deliveries the relay holds for this bot used to be invisible: the
// owner saw his own queued turns, and a stuck bot lane looked like silence.
describe('QueuePanel bot deliveries', () => {
  it('lists a held delivery beside the owner row, attributed to the sender bot, with no owner verbs', async () => {
    seedDelivery(deliveryRow({ queuedAt: Date.now() - MINUTE }))
    const view = await renderExpandedPanel([entry('mine', 'my words')], { busy: true, onSteerNow: vi.fn() })

    const botRow = rowOf('bot words')
    expect(within(botRow).getByText('ada')).toBeTruthy()
    expect(botRow.querySelector('.codicon-robot')).toBeTruthy()
    expect(botRow.querySelector('[data-slot="queue-bot-status"]')?.textContent).toBe(en.composer.queueBotQueued)
    // A bot delivery is not the owner's to steer, edit, send or delete.
    expect(rowButtons(botRow).sort()).toEqual([])

    // The owner's own row keeps every affordance it had.
    const mine = rowOf('my words')
    expect(rowButtons(mine)).toContain(en.composer.queueSendNext)
    expect(rowButtons(mine)).toContain(en.composer.queueEdit)
    expect(rowButtons(mine)).toContain(en.composer.queueSteer)
    expect(rowButtons(mine)).toContain(en.composer.queueDelete)

    // One FIFO: the older claim (the delivery) sits above the newer prompt.
    const text = Array.from(view.container.querySelectorAll('[data-slot="status-row"] p')).map(node => node.textContent)
    expect(text.indexOf('bot words')).toBeLessThan(text.indexOf('my words'))
  })

  it('changes queued -> delivering -> failed as the relay moves the row, and clears it on settle', async () => {
    seedDelivery()
    await renderExpandedPanel([])

    expect(screen.getByText(en.composer.queueBotQueued)).toBeTruthy()

    await act(async () => markDelivering('dlv-1'))
    expect(await screen.findByText(en.composer.queueBotDelivering)).toBeTruthy()

    await act(async () => failDelivery('dlv-1', 'target busy'))
    expect(await screen.findByText(en.composer.queueBotFailed)).toBeTruthy()
    expect(screen.getByText(en.composer.queueBotFailed).getAttribute('title')).toBe('target busy')

    await act(async () => settleDelivery('dlv-1'))
    expect(screen.queryByText('bot words')).toBeNull()
  })

  it('flags a delivery waiting longer than two minutes, with how long', async () => {
    const queuedAt = Date.now() - 5 * MINUTE
    seedDelivery(deliveryRow({ queuedAt }))
    await renderExpandedPanel([])

    expect(screen.getByText(en.composer.queueBotStuck(relativeTime(queuedAt)))).toBeTruthy()
  })

  it('shows the plain comment glyph for a server row without an author', async () => {
    await renderExpandedPanel([{ ...entry('adm-1', 'held by the gateway'), serverStatus: 'queued' }])

    const row = rowOf('held by the gateway')
    expect(row.querySelector('.codicon-comment')).toBeTruthy()
    expect(row.querySelector('.codicon-robot')).toBeNull()
  })

  it('renders the bot label for a server-owned row that carries an author', async () => {
    await renderExpandedPanel([
      { ...entry('adm-1', 'held by the gateway'), author: { isBot: true, name: 'ada' }, serverStatus: 'queued' }
    ])

    const row = rowOf('held by the gateway')
    expect(row.querySelector('.codicon-robot')).toBeTruthy()
    expect(within(row).getByText('ada')).toBeTruthy()
  })
})
