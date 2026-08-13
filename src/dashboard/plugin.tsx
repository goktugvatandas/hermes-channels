import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { CrewApi } from '../desktop/api'
import { CrewPage } from '../desktop/views/crew-page'

declare global {
  interface Window {
    __HERMES_PLUGIN_SDK__: {
      React: typeof import('react')
      fetchJSON<T>(url: string, init?: RequestInit): Promise<T>
    }
    __HERMES_PLUGINS__: {
      register(name: string, component: () => import('react').ReactNode): void
    }
  }
}

// Crew-owned host marker: session navigation and other host-specific
// behavior key off this instead of sniffing host SDK globals (which Hermes
// Desktop also defines).
;(window as Window & { __HERMES_CREW_HOST__?: string }).__HERMES_CREW_HOST__ = 'dashboard'

function dashboardRest<T>(path: string, options?: { body?: unknown; method?: string }): Promise<T> {
  const headers = new Headers()
  let body: string | undefined
  if (options?.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.body)
  }
  return window.__HERMES_PLUGIN_SDK__.fetchJSON<T>(
    `/api/plugins/hermes-crew${path}`,
    { body, headers, method: options?.method || 'GET' },
  )
}

function hostBackgroundIsDark(node: HTMLElement): boolean {
  let element: HTMLElement | null = node.parentElement
  while (element) {
    const color = getComputedStyle(element).backgroundColor
    // Only trust rgb()/rgba() serializations; modern color spaces (oklch,
    // color()) would mis-parse as tiny numbers and read as "dark".
    const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(color)
    if (match) {
      const alpha = match[4] === undefined ? 1 : Number(match[4])
      if (alpha > 0) {
        return 0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3]) < 128
      }
    }
    element = element.parentElement
  }
  return false
}

function HermesCrewDashboardPage() {
  const api = useMemo(() => new CrewApi(dashboardRest), [])
  const rootRef = useRef<HTMLDivElement>(null)
  const [offsetTop, setOffsetTop] = useState(64)
  const [dark, setDark] = useState(false)

  useLayoutEffect(() => {
    const node = rootRef.current
    if (!node) return
    let frame = 0
    const measure = () => {
      // Coalesce bursts (drag-resize, host style churn) into one layout read
      // per animation frame.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setOffsetTop(Math.max(0, Math.round(node.getBoundingClientRect().top + window.scrollY)))
        setDark(hostBackgroundIsDark(node))
      })
    }
    measure()
    window.addEventListener('resize', measure)
    // Host theme switches restyle <html>/<body>; re-detect light/dark live.
    const observer = new MutationObserver(measure)
    for (const target of [document.documentElement, document.body]) {
      if (target) observer.observe(target, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    }
    return () => {
      window.removeEventListener('resize', measure)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div
      className="hermes-crew-dashboard"
      data-crew-theme={dark ? 'dark' : 'light'}
      ref={rootRef}
      style={{ height: `calc(100dvh - ${offsetTop}px)`, minHeight: 480, overflow: 'hidden' }}
    >
      <CrewPage api={api} />
    </div>
  )
}

window.__HERMES_PLUGINS__.register('hermes-crew', HermesCrewDashboardPage)
