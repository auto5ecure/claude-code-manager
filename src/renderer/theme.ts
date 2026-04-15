export type Theme = 'dark' | 'light';

export const tokens = {
  dark: {
    bgPrimary: '#1a1a1a',
    bgSecondary: '#242424',
    bgTertiary: '#2d2d2d',
    bgSidebar: '#18181b',
    textPrimary: '#ffffff',
    textSecondary: '#a1a1aa',
    textMuted: '#52525b',
    border: '#27272a',
    accent: '#7c3aed',
    accentHover: '#6d28d9',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
  },
  light: {
    bgPrimary: '#ffffff',
    bgSecondary: '#f4f4f5',
    bgTertiary: '#e4e4e7',
    bgSidebar: '#fafafa',
    textPrimary: '#18181b',
    textSecondary: '#71717a',
    textMuted: '#a1a1aa',
    border: '#e4e4e7',
    accent: '#7c3aed',
    accentHover: '#6d28d9',
    success: '#16a34a',
    warning: '#d97706',
    error: '#dc2626',
  },
} as const;

export function applyTheme(theme: Theme) {
  const t = tokens[theme];
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.setProperty('--bg-primary', t.bgPrimary);
  root.style.setProperty('--bg-secondary', t.bgSecondary);
  root.style.setProperty('--bg-tertiary', t.bgTertiary);
  root.style.setProperty('--bg-sidebar', t.bgSidebar);
  root.style.setProperty('--text-primary', t.textPrimary);
  root.style.setProperty('--text-secondary', t.textSecondary);
  root.style.setProperty('--text-muted', t.textMuted);
  root.style.setProperty('--border', t.border);
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--accent-hover', t.accentHover);
  root.style.setProperty('--success', t.success);
  root.style.setProperty('--warning', t.warning);
  root.style.setProperty('--error', t.error);
}
