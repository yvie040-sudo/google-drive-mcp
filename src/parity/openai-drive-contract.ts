export const OPENAI_DRIVE_CONTRACT_AUDITED_AT = '2026-09-01';

export const OPENAI_DRIVE_TOOL_NAMES = [
  'batch_update_document','batch_update_presentation','batch_update_spreadsheet','bulk_update_file_comments','copy_file','create_file','create_folder','create_presentation_from_template','delete_file','duplicate_sheet_in_new_spreadsheet','export_file','fetch','fetch_file_revision','find_document_text_range','get_document','get_document_comments','get_document_paragraph_range','get_document_tables','get_document_text','get_file_comments','get_file_metadata','get_presentation','get_presentation_comments','get_presentation_outline','get_presentation_tables','get_presentation_text','get_profile','get_slide','get_slide_thumbnail','get_spreadsheet_cells','get_spreadsheet_comments','get_spreadsheet_metadata','get_spreadsheet_range','import_document','import_presentation','import_spreadsheet','list_drives','list_file_revisions','list_folder','recent_documents','search','search_spreadsheet_rows','share_file','update_file','upload_file',
] as const;

export const NICK_DRIVE_EXTRA_TOOL_NAMES = ['download_file_lro','get_download_operation','generate_drive_ids','empty_trash'] as const;
