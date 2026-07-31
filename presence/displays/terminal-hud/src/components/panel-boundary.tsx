import { Component, type ReactNode } from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

interface PanelBoundaryProps {
  children: ReactNode;
  fallbackPrefix: string;
}

interface PanelBoundaryState {
  error?: Error;
}

/**
 * One failing data source must never blank the whole HUD: a render error in a
 * panel is contained here and shown as a single error line.
 */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  override state: PanelBoundaryState = {};

  static getDerivedStateFromError(error: Error): PanelBoundaryState {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <Text color={theme.err}>
          {this.props.fallbackPrefix}: {this.state.error.message}
        </Text>
      );
    }
    return this.props.children;
  }
}
