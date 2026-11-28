import { Component, type ErrorInfo, type ReactNode } from "react";

export type ErrorReporter = (error: unknown, info?: ErrorInfo) => void;

interface Props {
  children: ReactNode;
  reporter?: ErrorReporter;
}

interface State {
  failed: boolean;
}

/**
 * Top-level error boundary. A render error shows a recoverable fallback instead
 * of a blank screen, and is reported once through `reporter` (Sentry in production).
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.reporter?.(error, info);
  }

  render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <section
        className="bcq-state bcq-state--error"
        data-testid="error-boundary-fallback"
        role="alert"
      >
        <p className="bcq-state__title">Something went wrong.</p>
        <button
          type="button"
          className="bcq-btn bcq-btn--primary bcq-state__action"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </button>
      </section>
    );
  }
}
