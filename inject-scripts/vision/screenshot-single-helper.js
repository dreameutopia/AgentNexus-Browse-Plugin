// --- In your background script (e.g., screenshot.ts) ---

// A helper function to send messages and wait for a response
async function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, resolve);
  });
}

/**
 * NEW: A clean, efficient function for capturing the visible area.
 */
async function captureVisibleArea(tab) {
  console.log('[Screenshot Tool] Capturing visible area...');

  // Step 1: Tell the content script to prepare the page
  // We wait for its confirmation before proceeding.
  await sendMessageToTab(tab.id, { action: 'preparePageForCapture' });

  // Step 2: Capture the visible tab ONCE. No loops.
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png'
  });

  // Step 3: Tell the content script to clean up and reset the page
  await sendMessageToTab(tab.id, { action: 'resetPageAfterCapture' });
  
  console.log('[Screenshot Tool] Visible area capture successful!');
  return dataUrl; // This is your final screenshot
}

/**
 * OLD: Your existing function for full-page capture (can remain unchanged)
 */
async function captureFullPage(tab) {
  console.log('[Screenshot Tool] Capturing full page...');
  // ... your original complex logic with the loop that calls 'scrollPage' repeatedly ...
  // This part does not need to be changed and can still be used for full-page captures.
}


// --- Example of how to use it ---
// You would have some logic (e.g., from a popup menu) to decide which function to call.

chrome.action.onClicked.addListener((tab) => {
  // For demonstration, let's say we have a variable or setting
  const captureMode = 'visible'; // This could come from user selection

  if (captureMode === 'visible') {
    // Call the new, efficient function
    captureVisibleArea(tab);
  } else if (captureMode === 'fullPage') {
    // Call the old, scrolling function
    captureFullPage(tab);
  }
});