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
  WEB_FETCHER_GET_TEXT_CONTENT: 'webFetcherGetTextContent',
  WEB_FETCHER_GET_HTML_CONTENT: 'getHtmlContent',
  NETWORK_CAPTURE_PING: 'network_capture_ping',
  CLICK_HELPER_PING: 'click_helper_ping',
  FILL_HELPER_PING: 'fill_helper_ping',
  KEYBOARD_HELPER_PING: 'keyboard_helper_ping',
  SCREENSHOT_HELPER_PING: 'screenshot_helper_ping',
  INTERACTIVE_ELEMENTS_HELPER_PING: 'interactive_elements_helper_ping',
} as const;

// Tool action message types (for chrome.runtime.sendMessage)
export const TOOL_MESSAGE_TYPES = {
  // Screenshot related
  SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE: 'preparePageForCapture',
  SCREENSHOT_GET_PAGE_DETAILS: 'getPageDetails',
  SCREENSHOT_GET_ELEMENT_DETAILS: 'getElementDetails',
  SCREENSHOT_SCROLL_PAGE: 'scrollPage',
  SCREENSHOT_RESET_PAGE_AFTER_CAPTURE: 'resetPageAfterCapture',

  // Web content fetching
  WEB_FETCHER_GET_HTML_CONTENT: 'getHtmlContent',
  WEB_FETCHER_GET_TEXT_CONTENT: 'getTextContent',

  // User interactions
  CLICK_ELEMENT: 'clickElement',
  SIMULATE_KEYBOARD: 'simulateKeyboard',

  // Network requests
  NETWORK_SEND_REQUEST: 'sendPureNetworkRequest',

} as const;

// Type unions for type safety
export type ContentMessageType = (typeof CONTENT_MESSAGE_TYPES)[keyof typeof CONTENT_MESSAGE_TYPES];
export type ToolMessageType = (typeof TOOL_MESSAGE_TYPES)[keyof typeof TOOL_MESSAGE_TYPES];

// Legacy enum for backward compatibility (will be deprecated)
export enum SendMessageType {
  // Screenshot related message types
  ScreenshotPreparePageForCapture = 'preparePageForCapture',
  ScreenshotGetPageDetails = 'getPageDetails',
  ScreenshotGetElementDetails = 'getElementDetails',
  ScreenshotScrollPage = 'scrollPage',
  ScreenshotResetPageAfterCapture = 'resetPageAfterCapture',

  // Web content fetching related message types
  WebFetcherGetHtmlContent = 'getHtmlContent',
  WebFetcherGetTextContent = 'getTextContent',

  // Click related message types
  ClickElement = 'clickElement',

  // Network request capture related message types
  NetworkSendRequest = 'sendPureNetworkRequest',

  // Keyboard event related message types
  SimulateKeyboard = 'simulateKeyboard',
}
