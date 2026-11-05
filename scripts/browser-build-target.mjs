// Injected functions are serialized without module scope by chrome.scripting.
// Keep async/await and object spread native: downlevel helpers break injection.
// Shared with the real-browser probe so tests exercise production transforms.
export const browserBuildTarget = 'es2022';
