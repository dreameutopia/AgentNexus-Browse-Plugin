/**
 * Consolidated message type constants for Chrome extension communication
 */

// Message targets for routing
export enum MessageTarget {
  ContentScript = 'content_script',
  Background = 'background',
}

// Content script message types
export const CONTENT_MESSAGE_TYPES = {
  NETWORK_CAPTURE_PING: 'network_capture_ping',
  CLICK_HELPER_PING: 'click_helper_ping',
  FILL_HELPER_PING: 'fill_helper_ping',
} as const;

// Tool action message types (for chrome.runtime.sendMessage)
export const TOOL_MESSAGE_TYPES = {
  // User interactions
  CLICK_ELEMENT: 'clickElement',

  // Network requests
  NETWORK_SEND_REQUEST: 'sendPureNetworkRequest',

} as const;

// Type unions for type safety
export type ContentMessageType = (typeof CONTENT_MESSAGE_TYPES)[keyof typeof CONTENT_MESSAGE_TYPES];
export type ToolMessageType = (typeof TOOL_MESSAGE_TYPES)[keyof typeof TOOL_MESSAGE_TYPES];

// Legacy enum for backward compatibility (will be deprecated)
export enum SendMessageType {
  // Click related message types
  ClickElement = 'clickElement',

  // Network request capture related message types
  NetworkSendRequest = 'sendPureNetworkRequest',

}
