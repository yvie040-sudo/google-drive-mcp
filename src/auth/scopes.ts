// ---------------------------------------------------------------------------
// Shared OAuth scope constants & resolution
// ---------------------------------------------------------------------------

export const SCOPE_ALIASES: Record<string, string> = {
  drive: 'https://www.googleapis.com/auth/drive',
  'drive.file': 'https://www.googleapis.com/auth/drive.file',
  'drive.readonly': 'https://www.googleapis.com/auth/drive.readonly',
  'drive.apps.readonly': 'https://www.googleapis.com/auth/drive.apps.readonly',
  documents: 'https://www.googleapis.com/auth/documents',
  spreadsheets: 'https://www.googleapis.com/auth/spreadsheets',
  presentations: 'https://www.googleapis.com/auth/presentations',
  calendar: 'https://www.googleapis.com/auth/calendar',
  'calendar.events': 'https://www.googleapis.com/auth/calendar.events',
  'drive.activity': 'https://www.googleapis.com/auth/drive.activity',
  'drive.activity.readonly': 'https://www.googleapis.com/auth/drive.activity.readonly',
  'drive.labels': 'https://www.googleapis.com/auth/drive.labels',
  'drive.labels.readonly': 'https://www.googleapis.com/auth/drive.labels.readonly',
  'drive.admin.labels': 'https://www.googleapis.com/auth/drive.admin.labels',
  'drive.admin.labels.readonly': 'https://www.googleapis.com/auth/drive.admin.labels.readonly',
};

export const SCOPE_PRESETS: Record<string, string[]> = {
  readonly: ['drive.readonly'],
  'content-editor': ['drive.file', 'documents', 'spreadsheets', 'presentations'],
  full: ['drive', 'documents', 'spreadsheets', 'presentations', 'calendar', 'calendar.events'],
};

export const DEFAULT_SCOPES: readonly string[] = [
  'drive', 'drive.file', 'drive.readonly',
  'documents', 'spreadsheets', 'presentations',
  'calendar', 'calendar.events',
].map((s) => SCOPE_ALIASES[s]);

/**
 * Optional power-pack scopes are deliberately aliases only. They are NOT added
 * to DEFAULT_SCOPES, so ordinary Drive parity does not silently broaden consent.
 */
export const OPTIONAL_POWER_SCOPES: readonly string[] = [
  SCOPE_ALIASES['drive.apps.readonly'],
  SCOPE_ALIASES['drive.activity.readonly'],
  SCOPE_ALIASES['drive.activity'],
  SCOPE_ALIASES['drive.labels.readonly'],
  SCOPE_ALIASES['drive.labels'],
  SCOPE_ALIASES['drive.admin.labels.readonly'],
  SCOPE_ALIASES['drive.admin.labels'],
];

export const USERINFO_SCOPES: readonly string[] = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function resolveOAuthScopes(): string[] {
  const raw = process.env.GOOGLE_DRIVE_MCP_SCOPES?.trim();
  if (!raw) return [...DEFAULT_SCOPES];

  const scopes = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (SCOPE_ALIASES[s]) return SCOPE_ALIASES[s];
      if (s.startsWith('https://')) return s;
      const known = Object.keys(SCOPE_ALIASES).join(', ');
      throw new Error(
        `Unknown OAuth scope alias "${s}". Use a full URL (https://...) or one of: ${known}`
      );
    });

  if (scopes.length === 0) return [...DEFAULT_SCOPES];
  return [...new Set(scopes)];
}

export function resolveAddAccountScopes(): string[] {
  return [...resolveOAuthScopes(), ...USERINFO_SCOPES];
}

export function splitScopes(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return [...new Set(scope.split(/\s+/).filter(Boolean))];
}
