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
      <div data-testid="error-boundary-fallback" role="alert">
        <p>Something went wrong.</p>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
