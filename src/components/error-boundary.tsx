'use client';

import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center h-full min-h-64 gap-4 text-center p-8">
          <div className="h-12 w-12 rounded-full bg-red-50 flex items-center justify-center">
            <span className="text-red-500 text-xl font-bold">!</span>
          </div>
          <div>
            <p className="font-semibold text-gray-900">Something went wrong</p>
            <p className="text-sm text-gray-500 mt-1">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-700 transition-colors"
          >
            Reload page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
