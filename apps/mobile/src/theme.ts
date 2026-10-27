import { Platform } from 'react-native';

/** Developer-focused dark theme. Colours meet WCAG AA contrast on `bg`. */
export const colors = {
  bg: '#0B0E14',
  surface: '#131823',
  surfaceAlt: '#1A2130',
  border: '#263044',
  text: '#E6EAF2',
  textMuted: '#9AA4B8',
  textFaint: '#6B7489',
  primary: '#5B9CFF',
  primaryText: '#0B0E14',
  local: '#4FD1A5', // Local Mac sessions
  cloud: '#B48CFF', // Managed cloud sessions
  success: '#4FD1A5',
  warning: '#F5C451',
  danger: '#FF6B6B',
  terminalBg: '#05070B',
} as const;

/** ANSI 16-colour palette for the terminal view. */
export const ansi = [
  '#1E2430',
  '#FF6B6B',
  '#4FD1A5',
  '#F5C451',
  '#5B9CFF',
  '#C792EA',
  '#56D4E0',
  '#C8CDD8',
  '#5C6577',
  '#FF8A8A',
  '#7BE3BE',
  '#FFD97A',
  '#8AB8FF',
  '#DDB3FF',
  '#8BE9F2',
  '#FFFFFF',
];

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14 } as const;

export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
});

export const type = {
  title: { fontSize: 24, fontWeight: '700' as const, color: colors.text },
  heading: { fontSize: 17, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 15, color: colors.text },
  small: { fontSize: 13, color: colors.textMuted },
  label: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  },
};
