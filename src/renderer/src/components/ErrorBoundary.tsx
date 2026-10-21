import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** When this changes (e.g. the user navigates), a previous error is cleared. */
  resetKey: string
}

/** A page that fails to render shows a message and a retry button instead of blanking the whole window. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI error', error, info.componentStack)
    void window.api.reportError(`${error.message}\n${(info.componentStack ?? '').split('\n').slice(0, 4).join('\n')}`)
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="empty">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Something went wrong on this page.</div>
        <div className="hint" style={{ marginBottom: 10 }}>{this.state.error.message}</div>
        <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}
