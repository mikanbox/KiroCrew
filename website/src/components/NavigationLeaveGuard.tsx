import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/** The mounted page's answer to "may I navigate away from you?". `true` allows
 *  the navigation, `false` keeps the user exactly where they are. */
export type NavigationLeaveGuard = () => boolean

type Channel = {
  register: (guard: NavigationLeaveGuard) => () => void
  ask: () => boolean
  /** Publish whether the page on screen is holding work an exit would destroy.
   *  Separate from `ask` because it must answer WITHOUT prompting: the browser
   *  Back guard needs to know there is something at stake before the user
   *  presses anything, and asking to find out would pop a confirm over a
   *  keystroke. */
  publishStake: (atStake: boolean) => void
  subscribeStake: (listener: (atStake: boolean) => void) => () => void
}

/** Null outside a provider, so both hooks below degrade to no-ops for a surface
 *  rendered standalone (tests, embedded uses) rather than crashing. */
const NavigationLeaveGuardContext = React.createContext<Channel | null>(null)

/**
 * Let the page currently on screen veto an in-app navigation that would unmount
 * it and destroy work the user typed.
 *
 * This is the same contract as `useSidePanelLeaveGuard`, one level further out.
 * That guard covers the exits a `SidePanelLayout` owns — its own tab rail and
 * mobile back bar — and `beforeunload` covers a real document unload. Neither
 * sees a CLIENT-SIDE ROUTE CHANGE: the global sidebar swaps the whole page
 * without the document ever unloading, so `beforeunload` never fires, and the
 * click belongs to the app shell rather than to any layout inside it.
 *
 * react-router's `useBlocker` is the mechanism that would normally answer this,
 * but it requires a data router (it reads `useDataRouterContext`) and the
 * dashboard mounts a plain `<BrowserRouter>`. So the veto is published the way
 * the pane-level one already is: the surface at risk registers an answer, and
 * the shell asks before it navigates.
 *
 * The exits wired to that answer are this layout's rail and mobile back bar, the
 * global sidebar's `NavItem`, the command palette's `usePaletteActions`
 * delegate, every notification-panel jump (through `useGuardedLeave`), and the
 * browser's own Back/Forward button (through `NavigationBackGuard`, which needs
 * the page to publish a stake — see `usePublishNavigationStake`).
 *
 * Coverage is still OPT-IN per navigation surface, which is the known cost of
 * this shape: an in-app `navigate()` caller that does not ask still discards a
 * draft, and forgetting to ask fails silently. A new surface should reach for
 * `useGuardedLeave` rather than hand-rolling the ask. Retiring the per-caller
 * model outright — a data router so `useBlocker` becomes available, or lifting
 * the draft so no exit destroys it — is tracked in #8010.
 */
export function NavigationLeaveGuardProvider({ children }: { children: React.ReactNode }) {
  // One slot, not a registry: exactly one page is on screen at a time, so two
  // simultaneous registrants cannot exist. Cleanup is identity-checked, which
  // is what stops an outgoing page's unmount from clearing the incoming page's
  // guard if the two ever interleave.
  const guard = React.useRef<NavigationLeaveGuard | null>(null)
  // Kept in refs and pushed to listeners rather than held in state: the answer
  // flips on the keystroke that first dirties a draft, and state here would
  // re-render the whole app under this provider to tell one listener.
  const stake = React.useRef(false)
  const stakeListeners = React.useRef(new Set<(atStake: boolean) => void>())
  const channel = React.useMemo<Channel>(() => ({
    register: g => {
      guard.current = g
      return () => { if (guard.current === g) guard.current = null }
    },
    // A page with nothing at stake registers no guard and this is a bare
    // `true`. The guard may show a confirm, so callers must only ever ask from
    // an event handler — never during render.
    ask: () => guard.current?.() !== false,
    publishStake: atStake => {
      if (stake.current === atStake) return
      stake.current = atStake
      // Iterated over a copy: a listener may unsubscribe from inside its own
      // callback, and mutating the live set mid-iteration would skip the next
      // listener.
      for (const listener of [...stakeListeners.current]) listener(atStake)
    },
    subscribeStake: listener => {
      stakeListeners.current.add(listener)
      // Delivered immediately, so a listener does not have to mount before the
      // page it is listening for. Without it, a guard mounted after a dirty
      // page (a remount, a StrictMode re-run) would sit disarmed.
      listener(stake.current)
      return () => { stakeListeners.current.delete(listener) }
    },
  }), [])
  return (
    <NavigationLeaveGuardContext.Provider value={channel}>
      {children}
    </NavigationLeaveGuardContext.Provider>
  )
}

/** Publish this surface's veto to the app shell. */
export function useRegisterNavigationLeaveGuard(guard: NavigationLeaveGuard) {
  const channel = React.useContext(NavigationLeaveGuardContext)
  // Register a stable trampoline over a ref, not `guard` itself: the guard
  // closes over the draft, so a new closure arrives on every keystroke.
  // Registering it directly would either re-run the effect per keystroke or
  // (with an empty dep list) pin the FIRST render's closure and read an empty
  // draft forever — losing exactly the text this exists to protect.
  const latest = React.useRef(guard)
  latest.current = guard
  React.useEffect(() => {
    if (!channel) return
    return channel.register(() => latest.current())
  }, [channel])
}

/**
 * Publish whether this surface is holding work right now.
 *
 * The guard above answers "may I leave?" by ASKING the user, which is only ever
 * safe from an event handler. `NavigationBackGuard` needs the answer one step
 * earlier — before any gesture — so it can arm itself while there is something
 * to lose and stay completely out of the history stack while there is not. A
 * page that registers a guard but publishes no stake keeps its old behaviour:
 * every wired in-app exit asks, and Back does not.
 */
export function usePublishNavigationStake(atStake: boolean) {
  const channel = React.useContext(NavigationLeaveGuardContext)
  React.useEffect(() => { channel?.publishStake(atStake) }, [channel, atStake])
  // Unmount-only, and deliberately NOT folded into the effect above, whose
  // cleanup also runs on every flip of `atStake`: a page that is gone holds
  // nothing, and leaving its last `true` published would keep the Back guard
  // armed for a draft that no longer exists.
  React.useEffect(() => () => { channel?.publishStake(false) }, [channel])
}

const ALWAYS_MAY_LEAVE = () => true

/** Ask the page on screen before an action that navigates away from it. */
export function useMayLeaveForNavigation(): () => boolean {
  const channel = React.useContext(NavigationLeaveGuardContext)
  return channel?.ask ?? ALWAYS_MAY_LEAVE
}

/**
 * Is this target the address we are already at, in full?
 *
 * The companion to `useMayLeaveForNavigation`: a navigation that changes nothing
 * unmounts nothing, and asking about it pops a discard-confirm the user never
 * earned. The test is the WHOLE address — pathname AND query — because a pane is
 * routinely mounted on the query (`{tab === 'prompts' && ...}` behind
 * `?tab=prompts`), so navigating from `/capabilities?tab=prompts` to a bare
 * `/capabilities` is a real unmount even though the pathname never moved. An
 * earlier revision compared the pathname alone and silently discarded exactly
 * the draft this channel exists to protect.
 */
export function useIsCurrentUrl(): (target: string) => boolean {
  const location = useLocation()
  const here = location.pathname + location.search
  return React.useCallback((target: string) => target === here, [here])
}

/**
 * Ask once, then run a whole handler that leaves the page.
 *
 * The gate goes in FRONT of the handler, not around its `navigate` call. A
 * wrapper over `useNavigate` can only veto the navigation, and these handlers do
 * more than navigate: `dispatch(switchSlot(s)); navigate('/chat')` would still
 * switch the slot when the user answers "keep my draft" — the draft survives, but
 * the app moved anyway, and the next visit to Chat lands somewhere they never
 * agreed to go. `await dispatch(resumeFromHistory(...))` in that position has
 * already resumed a session server-side, and `navigate(...); onClose()` closes
 * the panel the user was reading. Asking first makes the answer mean what it
 * says: nothing in the handler runs unless the page agreed to be left.
 *
 * Use a plain `useNavigate` inside — the ask has already happened.
 *
 * `to` is optional and only for the skip `useIsCurrentUrl` exists for: pass it
 * when the handler's target is data-driven and could be the address already on
 * screen, so a note pointing at the current page does not pop a discard-confirm
 * over a click that unmounts nothing.
 */
export function useGuardedLeave(): (perform: () => void | Promise<void>, to?: string) => void {
  const mayLeave = useMayLeaveForNavigation()
  const isCurrentUrl = useIsCurrentUrl()
  return React.useCallback((perform: () => void | Promise<void>, to?: string) => {
    if (!(to !== undefined && isCurrentUrl(to)) && !mayLeave()) return
    // A returned promise is deliberately not awaited: the gate answers "may this
    // run", and the handler owns its own async failure path (each one already
    // catches and logs).
    void perform()
  }, [mayLeave, isCurrentUrl])
}

/** Marks a history entry this guard minted, so it is recognisable when the
 *  location it belongs to is read back. */
const BACK_TRAP_STATE = '__navigationLeaveTrap'

const isTrapEntry = (state: unknown): boolean =>
  !!(state && typeof state === 'object' && (state as Record<string, unknown>)[BACK_TRAP_STATE] === true)

/** This entry's position in the router's own stack, or null when the router has
 *  not stamped one (a raw entry, or a history implementation without it). */
const routerIndex = (): number | null => {
  const state = window.history.state as { idx?: unknown } | null
  return typeof state?.idx === 'number' ? state.idx : null
}

/** How many entries sit above this one. The platform exposes only a total, and
 *  the router's index counts from the app's FIRST entry, so this number includes
 *  whatever was already in the tab below the dashboard — which is why it is only
 *  ever compared against its own value at mount, never against zero. */
const entriesAbove = (): number | null => {
  const idx = routerIndex()
  return idx === null ? null : window.history.length - 1 - idx
}

/**
 * Is a push here free, or would it destroy a Forward branch the user still owns?
 *
 * A push truncates everything above the current entry. That is unremarkable when
 * the USER asked to navigate, but this guard pushes on a KEYSTROKE — so an
 * unconditional push means typing into an editor silently throws away the Forward
 * history they built by pressing Back, which they can never get again.
 *
 * `baseline` is how many entries sat above the app's own entry when the guard
 * mounted (entries the app never minted and cannot reason about). A stack that has
 * grown beyond it means the user has moved BACKWARD and has a Forward branch to
 * lose, so the guard stays out. `ownedAbove` discounts entries above that this
 * guard minted itself and is free to replace — one, when re-arming immediately
 * after its own trap was popped.
 *
 * Fails CLOSED: with no router index there is no way to tell a free push from a
 * destructive one, so Back keeps its old, unguarded behaviour. A missing guard is
 * a gap; a truncated Forward branch is unrecoverable.
 */
const mayPushWithoutTruncating = (baseline: number | null, ownedAbove: number): boolean => {
  const above = entriesAbove()
  if (above === null || baseline === null) return false
  return above - ownedAbove <= baseline
}

/** The whole address, the way this guard compares two entries. */
const addressOf = (l: { pathname: string; search: string; hash: string }): string =>
  l.pathname + l.search + l.hash

/**
 * Route the browser's own Back/Forward button through the same veto.
 *
 * Back is the one exit nothing else here can reach. `beforeunload` is silent
 * (the document never unloads), the gesture belongs to no component, and
 * `useBlocker` — the mechanism built for exactly this — needs a data router the
 * dashboard does not mount. What is left is the stack itself: while the page on
 * screen has work at stake, this keeps ONE duplicate entry for the address it is
 * already at, so the first Back lands on the page's real entry with the address
 * unchanged and the page still mounted, draft intact. That pop is a real user
 * gesture, so it is safe to ask there — and the answer decides whether the Back
 * the user pressed is carried out or undone.
 *
 * Armed only while a stake is published AND only from the top of the stack,
 * which is what keeps it out of the way: a page with nothing to lose (every page
 * today except a dirty prompt editor) never gets a duplicate entry, so Back,
 * Forward, the mobile drill-in stack and every `location.key` consumer behave
 * exactly as before. The top-of-stack rule is not tidiness: a push truncates
 * everything above it, and this one happens on a KEYSTROKE, so arming after the
 * user has moved BACKWARD would make typing destroy the Forward branch they just
 * created. Where that cannot be ruled out the guard does nothing and Back keeps
 * its old behaviour — a gap, not a loss.
 *
 * Mount inside the router, once. This is a mechanism of last resort for the
 * gesture no caller owns — an in-app `navigate()` should be wired through
 * `useGuardedNavigate` instead, which needs no history entries at all.
 */
export function NavigationBackGuard() {
  const channel = React.useContext(NavigationLeaveGuardContext)
  const navigate = useNavigate()
  const location = useLocation()
  // The whole address, not the pathname: a trap pushed at the pathname alone
  // would drop the `?tab=` the pane is mounted on, and the "duplicate" entry
  // would itself be the unmount it exists to prevent (see `useIsCurrentUrl`).
  const here = location.pathname + location.search + location.hash
  // Read through a ref: both handlers below run from listeners registered once,
  // so closing over a render's values would pin the first one forever.
  const latest = React.useRef({ here, state: location.state as unknown })
  latest.current = { here, state: location.state as unknown }
  const armed = React.useRef(false)
  // The address the live trap duplicates. A pop is only THIS guard's business
  // when it lands there: `armed` alone cannot tell a single Back from a
  // multi-entry pop (a long-press Back menu, `history.go(-3)`), which lands past
  // the trap with the page already unmounted — where asking would confirm a
  // draft that is already gone and then pop one entry further.
  const trapAddress = React.useRef<string | null>(null)
  // Measured ONCE, on the mount that boots the app: everything above the app's
  // own entry at that moment belongs to the tab, not to this session's
  // navigation, and cannot be told apart from a Forward branch later.
  const stackBaseline = React.useRef<number | null>(null)
  if (stackBaseline.current === null) stackBaseline.current = entriesAbove()

  const pushTrap = React.useCallback(() => {
    armed.current = true
    trapAddress.current = latest.current.here
    // Pushed through the ROUTER rather than `history.pushState`: react-router
    // keeps its own index inside `history.state`, and a raw push overwrites it,
    // leaving the router's stack bookkeeping wrong for every later navigation.
    //
    // Carries ONLY this marker — the entry underneath keeps its own state, and
    // this one must not impersonate it. A trap that copied a mobile drill-in's
    // SUBNAV_PUSH_STATE would make `SidePanelLayout.backToRoot` take its POP
    // branch on an entry this guard minted: the pop would consume the trap, land
    // on the identical address, and read as a back bar that did nothing (with a
    // second confirm on top of the one the back bar already asked). Without the
    // marker those readers take their replace branch, which is the one written
    // for an entry they did not mint — and it lands on the right screen.
    navigate(latest.current.here, { state: { [BACK_TRAP_STATE]: true } })
  }, [navigate])

  React.useEffect(() => {
    if (!channel) return
    return channel.subscribeStake(atStake => {
      // Compared against `armed`, not against a previous value: the immediate
      // delivery on subscribe (and StrictMode's re-subscribe) would otherwise
      // push a second trap for a stake that is already trapped.
      if (atStake === armed.current) return
      // Nothing above this entry but our own (nothing at all, on a first arm), so
      // the duplicate costs the user no Forward history. When that cannot be
      // established the guard stays out of the stack entirely.
      if (atStake) { if (mayPushWithoutTruncating(stackBaseline.current, 0)) pushTrap(); return }
      armed.current = false
      trapAddress.current = null
      // Nothing at stake any more (saved, or discarded in place). Consume the
      // trap so the stack is left as it was found — but only while we are still
      // STANDING on it: after a confirmed navigation away, the trap is buried
      // under the new entry, and popping here would drag the user back to the
      // page they just chose to leave.
      if (isTrapEntry(latest.current.state)) window.history.go(-1)
    })
  }, [channel, pushTrap])

  React.useEffect(() => {
    if (!channel) return
    const onPop = () => {
      if (!armed.current) return
      // Read from the platform, not from a render: `popstate` fires before React
      // has committed the new location, so the ref still holds the old one.
      const landed = addressOf(window.location)
      if (landed !== trapAddress.current) {
        // The pop went PAST the trap (a multi-entry move), so the page this guard
        // was defending is already unmounted and there is nothing left to ask
        // about. Stand down rather than confirm a draft that is gone.
        armed.current = false
        trapAddress.current = null
        return
      }
      // The trap was the top entry, so this pop consumed it: the address has not
      // visibly changed and the page is still mounted with its text. Disarmed
      // FIRST, so the programmatic moves below are not mistaken for a second
      // Back press.
      armed.current = false
      trapAddress.current = null
      if (channel.ask()) {
        // Allowed. The trap absorbed the pop the user made, so the real one is
        // still owed. (A no-op when the page's own entry is the oldest in the
        // session — there was nowhere to go back to in the first place.)
        window.history.go(-1)
      } else {
        // Vetoed: the user stays, and a fresh trap makes sure the NEXT Back is
        // caught too. The one entry above is the trap this pop just left — this
        // guard's own, so replacing it truncates nothing of the user's.
        if (mayPushWithoutTruncating(stackBaseline.current, 1)) pushTrap()
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [channel, pushTrap])

  return null
}
