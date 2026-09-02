import { TOOL_META as BASE_TOOL_META, FALLBACK_META } from './toolMeta-base.js';
import type { ToolMeta } from './toolMeta-base.js';

const driveRead = BASE_TOOL_META.search;
const driveWrite = BASE_TOOL_META.createFolder;
const docsRead = BASE_TOOL_META.readGoogleDoc;
const docsWrite = BASE_TOOL_META.createGoogleDoc;
const sheetsRead = BASE_TOOL_META.getGoogleSheetContent;
const sheetsWrite = BASE_TOOL_META.createGoogleSheet;
const slidesRead = BASE_TOOL_META.getGoogleSlidesContent;
const slidesWrite = BASE_TOOL_META.createGoogleSlides;

const activityRead: ToolMeta = { opKind: 'read', acceptableScopes: ['https://www.googleapis.com/auth/drive.activity.readonly','https://www.googleapis.com/auth/drive.activity'] };
const labelCatalogRead: ToolMeta = { opKind: 'read', acceptableScopes: ['https://www.googleapis.com/auth/drive.labels.readonly','https://www.googleapis.com/auth/drive.labels','https://www.googleapis.com/auth/drive.admin.labels.readonly','https://www.googleapis.com/auth/drive.admin.labels'] };
const labelCatalogWrite: ToolMeta = { opKind: 'write', acceptableScopes: ['https://www.googleapis.com/auth/drive.labels','https://www.googleapis.com/auth/drive.admin.labels'] };

export const TOOL_META: Record<string, ToolMeta> = {
  ...BASE_TOOL_META,
  batch_update_document: docsWrite,
  batch_update_presentation: slidesWrite,
  batch_update_spreadsheet: sheetsWrite,
  bulk_update_file_comments: driveWrite,
  copy_file: driveWrite,
  create_file: driveWrite,
  create_folder: driveWrite,
  create_presentation_from_template: driveWrite,
  delete_file: driveWrite,
  duplicate_sheet_in_new_spreadsheet: sheetsWrite,
  export_file: driveRead,
  fetch: driveRead,
  fetch_file_revision: driveRead,
  find_document_text_range: docsRead,
  get_document: docsRead,
  get_document_comments: driveRead,
  get_document_paragraph_range: docsRead,
  get_document_tables: docsRead,
  get_document_text: docsRead,
  get_file_comments: driveRead,
  get_file_metadata: driveRead,
  get_presentation: slidesRead,
  get_presentation_comments: driveRead,
  get_presentation_outline: slidesRead,
  get_presentation_tables: slidesRead,
  get_presentation_text: slidesRead,
  get_profile: driveRead,
  get_slide: slidesRead,
  get_slide_thumbnail: slidesRead,
  get_spreadsheet_cells: sheetsRead,
  get_spreadsheet_comments: driveRead,
  get_spreadsheet_metadata: sheetsRead,
  get_spreadsheet_range: sheetsRead,
  import_document: driveWrite,
  import_presentation: driveWrite,
  import_spreadsheet: driveWrite,
  list_drives: driveRead,
  list_file_revisions: driveRead,
  list_folder: driveRead,
  recent_documents: driveRead,
  search_spreadsheet_rows: sheetsRead,
  share_file: driveWrite,
  update_file: driveWrite,
  upload_file: driveWrite,
  download_file_lro: driveRead,
  get_download_operation: driveRead,
  generate_drive_ids: driveWrite,
  empty_trash: driveWrite,
  list_file_labels: driveRead,
  modify_file_labels: driveWrite,
  list_drive_approvals: driveRead,
  manage_drive_approval: driveWrite,
  query_drive_activity: activityRead,
  drive_labels_catalog: labelCatalogRead,
  manage_drive_label_schema: labelCatalogWrite,
  get_shared_drive: driveRead,
  manage_shared_drive: driveWrite,
  get_drive_start_page_token: driveRead,
  list_drive_changes: driveRead,
  list_trash: driveRead,
  restore_from_trash: driveWrite,
  download_file_content: driveRead,
  get_file_permissions: driveRead,
  list_recent_files: driveRead,
  read_file_content: driveRead,
  search_files: driveRead,
};

export const ADMIN_TOOLS: ReadonlySet<string> = new Set(Object.entries(TOOL_META).filter(([, meta]) => meta.opKind === 'admin').map(([name]) => name));
export { FALLBACK_META };
export type { ToolMeta };
