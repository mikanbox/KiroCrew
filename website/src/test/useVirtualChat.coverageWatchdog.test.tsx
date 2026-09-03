/** Viewport-coverage watchdog: a displacement that leaves the viewport over
 *  bare spacer with NO follow-up event (no scroll, no resize) must re-cover
 *  within one watchdog tick -- the live failure was 3+ seconds of skeleton
 *  bars mid-stream with the reader sitting still. */
import { act, render } from '@testing-library/react'
import { type RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVirtualChat } from '../hooks/virtualizer/useVirtualChat'

type Item = { id: string; text: string }
const getKey = (it: Item) => it.id
const mkItems = (n: number, p = 'm'): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${p}-${i}`, text: `row ${i}` }))

function Harness({ items, scrollerRef }: {
  items: Item[]
  scrollerRef: RefObject<HTMLDivElement | null>
}) {
  const v = useVirtualChat<Item>({
    items, sessionId: 'watchdog', getKey, overscan: 2, externalScrollerRef: scrollerRef,
  })
  return (
    <div ref={scrollerRef as RefObject<HTMLDivElement>} data-scroller>
      <div ref={v.topSentinelRef} data-sentinel="top" />
      <div data-spacer="before" style={{ height: v.offsetBefore }} />
      {v.virtualItems.map((it) => (
        <div key={it.key} data-index={it.index} ref={v.measureRef(it.index)} />
      ))}
      <div data-spacer="after" style={{ height: v.offsetAfter }} />
      <div ref={v.bottomSentinelRef} data-sentinel="bottom" />
    </div>
  )
}

const ROW = 100
const CLIENT = 400

function installFakeLayout(scroller: HTMLElement) {
  const proto = HTMLElement.prototype
  const origRect = proto.getBoundingClientRect
  const childHeight = (child: Element): number => {
    if ((child as HTMLElement).getAttribute('data-index') !== null) return ROW
    const h = (child as HTMLElement).style?.height
    return h ? parseFloat(h) : 0
  }
  proto.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const rect = (y: number, h: number) =>
      ({ top: y, bottom: y + h, height: h, left: 0, right: 390, width: 390, x: 0, y, toJSON: () => ({}) }) as DOMRect
    if (this === scroller) return rect(0, CLIENT)
    if (this.parentElement === scroller) {
      let y = 0
      for (const sib of Array.from(scroller.children)) {
        if (sib === this) break
        y += childHeight(sib)
      }
      return rect(y - scroller.scrollTop, childHeight(this))
    }
    return origRect.call(this)
  }
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-index') !== null ? ROW : 0
    },
  })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => CLIENT })
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => Array.from(scroller.children).reduce((a, c) => a + childHeight(c), 0),
  })
  return () => {
    proto.getBoundingClientRect = origRect
  }
}

describe('viewport-coverage watchdog', () => {
  let restore: (() => void) | null = null
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    restore?.()
    restore = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function mountedSpan(el: HTMLElement): [number, number] {
    const rows = [...el.querySelectorAll('[data-index]')].map((r) => Number(r.getAttribute('data-index')))
    return rows.length ? [Math.min(...rows), Math.max(...rows)] : [-1, -1]
  }

  it('re-covers a silently displaced viewport within one tick', async () => {
    const scrollerRef = { current: null as HTMLDivElement | null }
    const items = mkItems(200)
    const view = render(<Harness items={items} scrollerRef={scrollerRef as RefObject<HTMLDivElement | null>} />)
    const el = scrollerRef.current as HTMLDivElement
    restore = installFakeLayout(el)
    // Settle the initial mount at the bottom.
    await act(async () => {
      el.scrollTop = 200 * ROW - CLIENT
      el.dispatchEvent(new Event('scroll'))
      await vi.advanceTimersByTimeAsync(50)
    })
    const [, hiBefore] = mountedSpan(el)
    expect(hiBefore).toBeGreaterThan(150)

    // A SILENT displacement: scrollTop moves into the top spacer's pixels
    // with no scroll event dispatched (the shape of a native-anchoring or
    // repricing jump whose compensations already consumed their events).
    await act(async () => {
      el.scrollTop = 20 * ROW
      // Deliberately NO dispatchEvent(scroll): nobody is told. Outwait the
      // yield window (the initial mount's recompute stamped the clock), then
      // one tick.
      await vi.advanceTimersByTimeAsync(1200 + 600)
    })
    view.rerender(<Harness items={items} scrollerRef={scrollerRef as RefObject<HTMLDivElement | null>} />)
    const [lo, hi] = mountedSpan(el)
    // The viewport [2000, 2400) must be covered by mounted rows 20..23.
    expect(lo).toBeLessThanOrEqual(20)
    expect(hi).toBeGreaterThanOrEqual(23)
  })

  it('stays quiet while the viewport is covered (no window churn)', async () => {
    const scrollerRef = { current: null as HTMLDivElement | null }
    const items = mkItems(200)
    render(<Harness items={items} scrollerRef={scrollerRef as RefObject<HTMLDivElement | null>} />)
    const el = scrollerRef.current as HTMLDivElement
    restore = installFakeLayout(el)
    await act(async () => {
      el.scrollTop = 200 * ROW - CLIENT
      el.dispatchEvent(new Event('scroll'))
      await vi.advanceTimersByTimeAsync(50)
    })
    const before = mountedSpan(el).join(',')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600) // three ticks, nothing displaced
    })
    expect(mountedSpan(el).join(',')).toBe(before)
  })

  it('yields while event-driven recomputes are alive (streaming must not bounce)', async () => {
    const scrollerRef = { current: null as HTMLDivElement | null }
    const items = mkItems(200)
    render(<Harness items={items} scrollerRef={scrollerRef as RefObject<HTMLDivElement | null>} />)
    const el = scrollerRef.current as HTMLDivElement
    restore = installFakeLayout(el)
    await act(async () => {
      el.scrollTop = 200 * ROW - CLIENT
      el.dispatchEvent(new Event('scroll'))
      await vi.advanceTimersByTimeAsync(50)
    })
    const before = mountedSpan(el).join(',')
    // Streaming shape: scroll events keep arriving (the event-driven path is
    // alive and recomputing). The watchdog must NOT interject its own
    // recomputes between them, even though mid-stream tree pricing may
    // legitimately disagree with live geometry.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        el.dispatchEvent(new Event('scroll'))
        await vi.advanceTimersByTimeAsync(400)
      })
    }
    expect(mountedSpan(el).join(',')).toBe(before)
  })
})
