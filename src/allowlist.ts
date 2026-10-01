/**
 * Every event name the service stores. Anything else is dropped and counted in
 * `analytics_session.rejected`. The endpoint is public, and without this it would be a free
 * write-anything-to-our-database API.
 *
 * Source of truth: momoto-fe's taxonomy (`docs/plans/PLAN-observability.md`, and
 * `src/analytics/events.ts` once it exists). Adding an event there means adding it here
 * too, in the same change — an event the service doesn't know is silently lost. A CI check
 * comparing the two lists is planned for when `events.ts` lands.
 */
export const EVENT_NAMES = new Set([
  // Lifecycle
  'app_open',
  'page_view',
  'click',
  'visit_hidden',
  'signed_out',
  // Auth
  'auth_submitted',
  'auth_succeeded',
  'auth_failed',
  'email_verification_opened',
  'password_reset_requested',
  'password_reset_completed',
  // Booth funnel
  'booth_mode_selected',
  'camera_requested',
  'camera_granted',
  'camera_denied',
  'room_created',
  'room_joined',
  'room_refused',
  'peer_connected',
  'peer_failed',
  'peer_dropped',
  'session_started',
  'shot_taken',
  'capture_completed',
  'retake_requested',
  'stage_entered',
  'template_selected',
  'filter_selected',
  'backdrop_selected',
  'sticker_added',
  'strip_created',
  'strip_downloaded',
  'strip_shared',
  'session_finished',
  'session_expired',
  // Commerce
  'cart_viewed',
  'strip_added_to_cart',
  'unlock_clicked',
  'checkout_started',
  'payment_succeeded',
  'payment_failed',
  'gallery_viewed',
  'strip_deleted',
  // Health
  'client_error',
  'api_failed',
  'network_trouble',
  'server_status_changed',
  'web_vital',
  'timing',
])
