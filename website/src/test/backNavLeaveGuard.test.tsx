/**
 * The browser's own Back button asks the page on screen before it discards a
 * draft.
 *
 * Back was the last exit nothing in the app could reach. `beforeunload` is
 * silent for it (the document never unloads), the gesture belongs to no
 * component so there is no click handler to wire, and `useBlocker` — the
 * mechanism built for exactly this — needs a data router the dashboard does not
 * mount. `NavigationBackGuard` closes it through the stack instead: while the
 * page publishes work at stake it keeps one duplicate history entry, so the
 * first Back lands on the page's own entry with the address unchanged and the
 * page still mounted, and the veto is asked there.
 *
 * These pin the parts that make that honest rather than decorative:
 *  - a declined confirm leaves the page MOUNTED WITH ITS TEXT, not merely the
 *    URL alone — and the NEXT Back is still caught, so refusing once does not
 *    spend the guard;
 *  - an accepted confirm actually leaves, in ONE press: the trap absorbed the
 *    pop, so the real one still has to be carried out;
 *  - a page with nothing at stake is not merely quiet but ABSENT from the stack
 *    — no duplicate entry, so Back means what it always meant;
 *  - the same guard answers, so a page that saves its work stops being asked
 *    about.
 *
 * Uses a real `<BrowserRouter>` over jsdom's history rather than MemoryRouter,
 * because the whole subject is `popstate` and the browser stack — a memory
 * router never fires it.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import SidePanelLayout, { useSidePanelLeaveGuard, type SidePanelTab } from '../components/SidePanelLayout'
import {
  NavigationLeaveGuardProvider,
  NavigationBackGuard,
  useMayLeaveForNavigation,
} from '../components/NavigationLeaveGuard'

// Flipped per describe block: the mobile back bar reaches history through
// `navigate(-1)`, which is the one in-app exit a trap entry can collide with.
const viewport = vi.hoisted(() => ({ mobile: false }))
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => viewport.mobile }))

const TABS: SidePanelTab[] = [
  { key: 'drafts', label: 'Drafts', icon: null },
  { key: 'other', label: 'Other', icon: null },
]

/** A pane shaped like PromptsTab's editor: the draft lives in component-local
 *  state, so an unmount is what destroys it. It publishes the same dirtiness
 *  twice — as the guard's answer and as the stake that arms Back. */
function DraftPane() {
  const [draft, setDraft] = React.useState('')
  useSidePanelLeaveGuard(() => !draft || confirm('Discard unsaved changes?'), !!draft)
  return (
    <input
      aria-label="draft"
      value={draft}
      onChange={e => setDraft((e.target as HTMLInputElement).value)}
    />
  )
}

function CapabilitiesLike() {
  return (
    <SidePanelLayout title="Capabilities" tabs={TABS}>
      {tab => <>
        {tab === 'drafts' && <DraftPane />}
        {tab !== 'drafts' && <div data-testid="plain">{tab}</div>}
      </>}
    </SidePanelLayout>
  )
}

/** The app shell's nav row, reduced to the one thing that matters here: it asks
 *  before it navigates, exactly as App.tsx's NavItem does. Present so a test can
 *  reach the state where a CONFIRMED in-app navigation has buried the trap. */
function SidebarRow({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate()
  const mayLeave = useMayLeaveForNavigation()
  return <button onClick={() => { if (!mayLeave()) return; navigate(to) }}>{label}</button>
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname + loc.search}</div>
}

const renderDashboard = () =>
  render(
    <NavigationLeaveGuardProvider>
      <BrowserRouter>
        <NavigationBackGuard />
        <SidebarRow to="/chat" label="Chat" />
        <Routes>
          <Route path="/capabilities" element={<CapabilitiesLike />} />
          <Route path="/chat" element={<div data-testid="page">chat</div>} />
          <Route path="/schedule" element={<div data-testid="page">schedule</div>} />
        </Routes>
        <LocationProbe />
      </BrowserRouter>
    </NavigationLeaveGuardProvider>,
  )

const typeDraft = (value: string) =>
  fireEvent.change(screen.getByLabelText('draft'), { target: { value } })
const draftValue = () => (screen.getByLabelText('draft') as HTMLInputElement).value
const loc = () => screen.getByTestId('loc').textContent

/** The entry the user arrived from, so Back has somewhere real to go — and, for
 *  the multi-entry pop case, something to land on past the trap. */
const startAtCapabilities = () => {
  window.history.replaceState(null, '', '/schedule')
  window.history.pushState(null, '', '/capabilities')
}

/** jsdom applies `back()` in a task, and the guard answers inside the resulting
 *  `popstate` — so every assertion about Back has to be awaited. */
const pressBack = async (settle: () => void) => {
  window.history.back()
  await waitFor(settle)
}

describe('browser Back navigation leave guard', () => {
  beforeEach(() => { sessionStorage.clear(); startAtCapabilities() })
  afterEach(() => { vi.restoreAllMocks(); cleanup() })

  it('does not touch the history stack for a page with nothing at stake', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDashboard()
    await waitFor(() => expect(screen.getByLabelText('draft')).toBeInTheDocument())
    // A clean page must be ABSENT from the stack, not merely quiet: with a trap
    // pushed regardless, this Back would land on the duplicate entry and appear
    // to do nothing at all.
    await pressBack(() => expect(loc()).toBe('/schedule'))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('keeps the page mounted with its draft when the confirm is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDashboard()
    typeDraft('half-written prompt')
    await pressBack(() => expect(confirmSpy).toHaveBeenCalled())
    // Not just "the URL is unchanged" but "the text is still there": a veto that
    // let the page unmount would pass a URL-only assertion and still lose the
    // draft.
    expect(draftValue()).toBe('half-written prompt')
    expect(loc()).toBe('/capabilities')
    expect(screen.queryByTestId('page')).toBeNull()
  })

  it('still catches the next Back after one refusal', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDashboard()
    typeDraft('half-written prompt')
    await pressBack(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    // Refusing consumes the trap. Without a fresh one the second press walks
    // straight out of the page, which is the same silent loss with one extra
    // click in front of it.
    await pressBack(() => expect(confirmSpy).toHaveBeenCalledTimes(2))
    expect(draftValue()).toBe('half-written prompt')
    expect(loc()).toBe('/capabilities')
  })

  it('leaves on a single press once the confirm is accepted', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDashboard()
    typeDraft('half-written prompt')
    // ONE press: the trap absorbed the user's pop, so the guard owes the real
    // one. Leaving that out would make Back need two presses on every dirty
    // page — the trap would read as a Back that did nothing.
    await pressBack(() => expect(loc()).toBe('/schedule'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('draft')).toBeNull()
  })

  it('stops asking, and leaves no entry behind, once the work is gone', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDashboard()
    typeDraft('typed then thrown away')
    typeDraft('')
    // The stake is withdrawn, so the trap it armed must be consumed too:
    // otherwise this Back lands on the leftover duplicate and does nothing
    // visible.
    await pressBack(() => expect(loc()).toBe('/schedule'))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('does not drag the user back to a page they confirmed leaving', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDashboard()
    typeDraft('half-written prompt')
    // An in-app navigation the user accepted buries the trap under the new
    // entry. Withdrawing the stake must NOT pop there — that would undo the
    // navigation the user just asked for.
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await waitFor(() => expect(loc()).toBe('/chat'))
    expect(screen.getByTestId('page').textContent).toBe('chat')
  })

  it('does not spend the user\'s Forward branch on a keystroke', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDashboard()
    // Build a Forward branch the way a user does: go somewhere, come back.
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await waitFor(() => expect(loc()).toBe('/chat'))
    await pressBack(() => expect(loc()).toBe('/capabilities'))
    const lengthBeforeTyping = window.history.length
    typeDraft('half-written prompt')
    // A push truncates everything above it, and this one would fire on a
    // KEYSTROKE — so arming here would destroy /chat, which the user can never
    // get back. The guard stays out of the stack instead: Back is unguarded on
    // this entry (a gap), but nothing is lost.
    expect(window.history.length).toBe(lengthBeforeTyping)
    window.history.forward()
    await waitFor(() => expect(loc()).toBe('/chat'))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('stands down for a pop that lands PAST the trap', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDashboard()
    typeDraft('half-written prompt')
    // A long-press Back menu or history.go(-n) skips the duplicate entirely, so
    // the page is already unmounted by the time the guard hears about it.
    // Correlating any pop with its own trap would confirm a draft that is
    // already gone and then pop one entry further.
    window.history.go(-2)
    await waitFor(() => expect(loc()).toBe('/schedule'))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('degrades to plain Back with no provider, rather than crashing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <BrowserRouter>
        <NavigationBackGuard />
        <Routes>
          <Route path="/capabilities" element={<CapabilitiesLike />} />
          <Route path="/schedule" element={<div data-testid="page">schedule</div>} />
        </Routes>
        <LocationProbe />
      </BrowserRouter>,
    )
    typeDraft('half-written prompt')
    // No channel to arm from and none to ask. Pinned because the layout is
    // rendered standalone in other tests and in embedded surfaces, where a guard
    // that assumed a provider would throw on mount.
    await pressBack(() => expect(loc()).toBe('/schedule'))
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})

/**
 * The mobile back bar is the in-app exit that reaches history directly: with a
 * pushed drill-in entry under it, `SidePanelLayout.backToRoot` pops via
 * `navigate(-1)`. A trap sitting on top of that entry is what makes this worth
 * pinning — an earlier revision copied the drill-in's `SUBNAV_PUSH_STATE` marker
 * onto the trap, so the pop consumed the trap instead, landed on the identical
 * address, and read as a back bar that did nothing while asking a second time.
 */
describe('browser Back guard alongside the mobile back bar', () => {
  beforeEach(() => { viewport.mobile = true; sessionStorage.clear(); startAtCapabilities() })
  afterEach(() => { viewport.mobile = false; vi.restoreAllMocks(); cleanup() })

  /** Mobile opens at the root list; drilling in is what mounts the pane. */
  const drillIn = () => fireEvent.click(screen.getByRole('button', { name: 'Drafts' }))
  const backBar = () => fireEvent.click(screen.getByRole('button', { name: /Capabilities/ }))

  it('asks once and reaches the root list when the back bar is tapped', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDashboard()
    drillIn()
    typeDraft('half-written prompt')
    backBar()
    // ONE confirm: the back bar already asked through the pane's own guard, and
    // the trap must not turn that into a second question.
    await waitFor(() => expect(screen.queryByLabelText('draft')).toBeNull())
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    // The root list, not the address it was already at.
    expect(loc()).toBe('/capabilities')
  })

  it('keeps the drafted pane when the back bar ask is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDashboard()
    drillIn()
    typeDraft('half-written prompt')
    backBar()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(draftValue()).toBe('half-written prompt')
    // And the browser's own Back is still trapped afterwards.
    await pressBack(() => expect(confirmSpy).toHaveBeenCalledTimes(2))
    expect(draftValue()).toBe('half-written prompt')
  })
})
