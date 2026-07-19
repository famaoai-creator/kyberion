// Browser-extension operation policy. Keep this as the extension-side source of
// truth; the native bridge remains authoritative and validates the same
// operation vocabulary before issuing a lease.
export const BROWSER_OPERATION_POLICY = Object.freeze({
  safe: Object.freeze([
    'snapshot',
    'screenshot',
    'extract_text_ref',
    'list_tabs',
    'open_tab',
    'select_tab',
    'click_ref',
    'click_if_present',
    'fill_ref',
    'select_ref',
    'press_ref',
    'wait_for_ref',
    'submit_form',
    'sensitive_input_omitted',
  ]),
  highRisk: Object.freeze([
    'submit_form',
    'upload_file',
    'download_file',
    'delete',
    'purchase',
    'credential_submit',
    'settings_change',
  ]),
});
