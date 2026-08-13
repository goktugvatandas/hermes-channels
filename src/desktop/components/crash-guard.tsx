import { Component, type ReactNode } from 'react'

interface CrashGuardProps {
  label: string
  onClose?(): void
  children: ReactNode
}

interface CrashGuardState {
  error: string | null
}

/**
 * Renders a visible failure card instead of a dead surface when a subtree
 * throws. Host environments differ (SDK capabilities, gateway state), and an
 * invisible crash reads as "the button does nothing".
 */
export class CrashGuard extends Component<CrashGuardProps, CrashGuardState> {
  state: CrashGuardState = { error: null }

  static getDerivedStateFromError(error: unknown): CrashGuardState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  render() {
    if (this.state.error === null) return this.props.children
    return (
      <section className="m-auto grid max-w-md gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
        <p className="text-sm font-semibold">{this.props.label} hit an error</p>
        <p className="break-words text-xs text-(--ui-text-secondary)">{this.state.error}</p>
        {this.props.onClose ? <button className="mx-auto rounded-lg border border-(--ui-stroke-secondary) px-3 py-1.5 text-sm font-medium hover:bg-(--ui-surface-secondary)" onClick={this.props.onClose} type="button">Close</button> : null}
      </section>
    )
  }
}
