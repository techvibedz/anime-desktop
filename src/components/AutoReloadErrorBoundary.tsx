import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null; retrying: boolean };

const RELOAD_FLAG = "pantoufa:auto-reload-error";

export class AutoReloadErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retrying: false };
  private timer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): State {
    return { error, retrying: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[app] render crash, scheduling reload", error, info.componentStack);
    const alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) === "1";
    if (alreadyReloaded) {
      this.setState({ retrying: false });
      return;
    }
    sessionStorage.setItem(RELOAD_FLAG, "1");
    this.timer = setTimeout(() => window.location.reload(), 800);
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-text-secondary">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm font-semibold text-white">
            {this.state.retrying ? "Reloading Pantoufa..." : "Something failed while loading."}
          </p>
          {!this.state.retrying && (
            <button
              type="button"
              onClick={() => {
                sessionStorage.removeItem(RELOAD_FLAG);
                window.location.reload();
              }}
              className="rounded-full bg-accent px-5 py-2 text-sm font-bold text-black transition-colors hover:bg-accent-bright"
            >
              Reload now
            </button>
          )}
        </div>
      );
    }
    sessionStorage.removeItem(RELOAD_FLAG);
    return this.props.children;
  }
}
