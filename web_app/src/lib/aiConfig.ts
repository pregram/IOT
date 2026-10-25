/**
 * Key for the Settings drawer's "Test Gemini" button: one request to
 * GEMINI_TEST_MODEL from the host browser, to check reachability and quota
 * independently of the board's own key pool. The result is display-only.
 *
 * Left empty in the published repo; paste a key locally to use the button (an empty
 * key makes the drawer show "not configured" instead of sending a doomed request).
 * The key ships to the host browser, so do not commit a real one.
 */
export const GEMINI_TEST_KEY = '';

export const GEMINI_TEST_MODEL = 'gemini-3.6-flash';

/** One bounded attempt, no retry cascade. */
export const GEMINI_TEST_TIMEOUT_MS = 12000;
