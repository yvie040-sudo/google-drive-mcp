import type { drive_v3, calendar_v3 } from 'googleapis';
import type { google as GoogleApisType } from 'googleapis';
import type { RuntimeConfig } from './utils/cliArgs.js';
import type {
  AccountRecord,
  AccountTargeting,
  AuthMode,
  RedactedAccountView,
  ToolOpKind,
} from './auth/types.js';

export interface ToolContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  size?: number;
  resource?: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ToolResult {
  [key: string]: unknown;
  content: ToolContentBlock[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ToolContext {
  authClient: any;
  google: typeof GoogleApisType;
  getDrive: () => drive_v3.Drive;
  getCalendar: () => calendar_v3.Calendar;
  log: (message: string, data?: any) => void;
  resolvePath: (pathStr: string) => Promise<string>;
  resolveFolderId: (input: string | undefined) => Promise<string>;
  checkFileExists: (name: string, parentFolderId?: string) => Promise<string | null>;
  validateTextFileExtension: (name: string) => void;
  runtimeConfig: RuntimeConfig;
  sessionId: string;
  resolveAccount: (
    input: string | string[] | undefined,
    kind: ToolOpKind,
    acceptableScopes: string[],
  ) => Promise<AccountTargeting>;
  getDriveFor: (account: AccountRecord) => Promise<drive_v3.Drive>;
  getCalendarFor: (account: AccountRecord) => Promise<calendar_v3.Calendar>;
  getAuthClientFor: (account: AccountRecord) => Promise<any>;
  accountOps: AccountOps;
}

export interface AddAccountResult {
  authUrl: string;
  completion: Promise<AccountRecord>;
  cancel: () => Promise<void>;
}

export interface AccountOps {
  mode: AuthMode;
  list(): RedactedAccountView[];
  getDefault(): string | undefined;
  add(alias: string, opts?: { openBrowser?: boolean }): Promise<AddAccountResult>;
  remove(alias: string): Promise<void>;
  setDefault(alias: string | null): Promise<void>;
}

export function errorResponse(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
