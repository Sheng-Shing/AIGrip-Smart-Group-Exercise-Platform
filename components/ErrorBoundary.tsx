// @ts-nocheck
import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
    children?: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = {
            hasError: false,
            error: null
        };
    }

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Uncaught error:", error, errorInfo);
    }

    public render() {
        if (this.state.hasError) {
            return <>{(this.props as Props).fallback}</> || (
                <div className="p-4 bg-red-900/50 border border-red-500 rounded-lg text-red-200">
                    <h2 className="text-lg font-bold mb-2">Something went wrong.</h2>
                    <details className="whitespace-pre-wrap text-sm font-mono">
                        {this.state.error && this.state.error.toString()}
                    </details>
                </div>
            );
        }

        return (this.props as Props).children;
    }
}

export default ErrorBoundary;
