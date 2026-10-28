import { Component, type ErrorInfo, type ReactNode } from "react";
import { logUiError } from "@/lib/diagnostics";

interface ErrorBoundaryProps {
  /** Names the region in the log. */
  name: string;
  /** Changing it clears a caught error and draws the children again (a new view). */
  resetKey?: unknown;
  fallback: (retry: () => void) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
  resetKey: unknown;
}

/**
 * Keeps a render error inside the region that threw it. Without one, React unmounts the
 * whole app: the window goes blank and the shell's cleanup ends the call.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    logUiError(`render error in ${this.props.name}`, error, info.componentStack);
  }

  retry = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}
