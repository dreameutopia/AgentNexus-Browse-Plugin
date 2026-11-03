// click-helper.js
// This script is injected into the page to handle click operations

if (window.__CLICK_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__CLICK_HELPER_INITIALIZED__ = true;
  /**
   * Click on an element matching the selector or at specific coordinates
   * @param {string} selector - CSS selector for the element to click
   * @param {boolean} waitForNavigation - Whether to wait for navigation to complete after click
   * @param {number} timeout - Timeout in milliseconds for waiting for the element or navigation
   * @param {Object} coordinates - Optional coordinates for clicking at a specific position
   * @param {number} coordinates.x - X coordinate relative to the viewport
   * @param {number} coordinates.y - Y coordinate relative to the viewport
   * @returns {Promise<Object>} - Result of the click operation
   */
  async function clickElement(
    selector,
    waitForNavigation = false,
    timeout = 5000,
    coordinates = null,
    index = 0, // <-- Supports sequential clicking
  ) {
    try {
      let element;

      if (coordinates && typeof coordinates.x === 'number' && typeof coordinates.y === 'number') {
        // Coordinate-based clicking remains the same
        element = document.elementFromPoint(coordinates.x, coordinates.y);
        if (element) {
          element.click(); // Standard click is fine for coordinates
        } else {
          return { error: 'No element found at specified coordinates' };
        }
      } else {
        // --- CORE FIXES FOR SELECTOR-BASED CLICKING ---

        // 1. Use querySelectorAll to find all matching elements
        const elements = document.querySelectorAll(selector);

        if (elements.length === 0) {
          return { error: `Element with selector "${selector}" not found` };
        }
        if (index >= elements.length) {
          return { error: `Index ${index} is out of bounds for selector "${selector}" which found ${elements.length} elements.` };
        }

        // 2. Select the correct element based on the index
        element = elements[index];

        // 3. Scroll the element into view. This is crucial.
        element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });

        // Wait a brief moment for the scroll to finish
        await new Promise(resolve => setTimeout(resolve, 200));

        // 4. Use a robust JavaScript "force click" that bypasses overlays
        element.dispatchEvent(new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
        }));
      }

      // Navigation waiting logic (no changes needed here)
      let navigationPromise;
      if (waitForNavigation) {
        navigationPromise = new Promise((resolve) => {
          const beforeUnloadListener = () => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(true);
          };
          window.addEventListener('beforeunload', beforeUnloadListener);
          setTimeout(() => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(false);
          }, timeout);
        });
      }

      let navigationOccurred = false;
      if (waitForNavigation) {
        navigationOccurred = await navigationPromise;
      }

      // Simplified success response
      const rect = element.getBoundingClientRect();
      return {
        success: true,
        message: `Element at index ${index} clicked successfully via JavaScript.`,
        navigationOccurred,
        elementInfo: {
            tagName: element.tagName,
            text: element.textContent?.trim().substring(0, 100) || '',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
      };

    } catch (error) {
      return { error: `Error clicking element: ${error.message}` };
    }
  }

  /**
   * Simulate a mouse click at specific coordinates
   * @param {number} x - X coordinate relative to the viewport
   * @param {number} y - Y coordinate relative to the viewport
   */
  function simulateClick(x, y) {
    const clickEvent = new MouseEvent('click', {
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });

    const element = document.elementFromPoint(x, y);

    if (element) {
      element.dispatchEvent(clickEvent);
    } else {
      document.dispatchEvent(clickEvent);
    }
  }

  /**
   * Check if an element is visible
   * @param {Element} element - The element to check
   * @returns {boolean} - Whether the element is visible
   */
  function isElementVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return false;
    }

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const elementAtPoint = document.elementFromPoint(centerX, centerY);
    if (!elementAtPoint) return false;

    return element === elementAtPoint || element.contains(elementAtPoint);
  }

  /**
   * Simulate a double-click at specific coordinates
   * @param {Object} coordinates - {x, y} coordinates
   * @returns {Promise<Object>}
   */
  async function simulateDoubleClick(coordinates) {
    const { x, y } = coordinates;
    const element = document.elementFromPoint(x, y);
    
    if (!element) {
      return { 
        success: false,
        error: `No element found at coordinates (${x}, ${y})` 
      };
    }

    try {
      const mouseEventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1
      };

      // First click
      element.dispatchEvent(new MouseEvent('mousedown', mouseEventOptions));
      await new Promise(resolve => setTimeout(resolve, 50));
      element.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0 }));
      element.dispatchEvent(new MouseEvent('click', { ...mouseEventOptions, buttons: 0 }));
      
      // Short delay between clicks
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Second click
      element.dispatchEvent(new MouseEvent('mousedown', mouseEventOptions));
      await new Promise(resolve => setTimeout(resolve, 50));
      element.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0 }));
      element.dispatchEvent(new MouseEvent('click', { ...mouseEventOptions, buttons: 0 }));
      
      // Double-click event
      element.dispatchEvent(new MouseEvent('dblclick', { ...mouseEventOptions, buttons: 0 }));

      return {
        success: true,
        message: 'Double-click successful',
        elementInfo: {
          tagName: element.tagName,
          text: element.textContent?.trim().substring(0, 100) || ''
        }
      };
    } catch (error) {
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  /**
   * Simulate a triple-click at specific coordinates (selects entire paragraph/line)
   * @param {Object} coordinates - {x, y} coordinates
   * @returns {Promise<Object>}
   */
  async function simulateTripleClick(coordinates) {
    const { x, y } = coordinates;
    const element = document.elementFromPoint(x, y);
    
    if (!element) {
      return { 
        success: false,
        error: `No element found at coordinates (${x}, ${y})` 
      };
    }

    try {
      const mouseEventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
        detail: 1
      };

      // First click
      element.dispatchEvent(new MouseEvent('mousedown', { ...mouseEventOptions, detail: 1 }));
      await new Promise(resolve => setTimeout(resolve, 50));
      element.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0, detail: 1 }));
      element.dispatchEvent(new MouseEvent('click', { ...mouseEventOptions, buttons: 0, detail: 1 }));
      
      // Short delay between clicks
      await new Promise(resolve => setTimeout(resolve, 80));
      
      // Second click
      element.dispatchEvent(new MouseEvent('mousedown', { ...mouseEventOptions, detail: 2 }));
      await new Promise(resolve => setTimeout(resolve, 50));
      element.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0, detail: 2 }));
      element.dispatchEvent(new MouseEvent('click', { ...mouseEventOptions, buttons: 0, detail: 2 }));
      element.dispatchEvent(new MouseEvent('dblclick', { ...mouseEventOptions, buttons: 0, detail: 2 }));
      
      // Short delay before third click
      await new Promise(resolve => setTimeout(resolve, 80));
      
      // Third click
      element.dispatchEvent(new MouseEvent('mousedown', { ...mouseEventOptions, detail: 3 }));
      await new Promise(resolve => setTimeout(resolve, 50));
      element.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0, detail: 3 }));
      element.dispatchEvent(new MouseEvent('click', { ...mouseEventOptions, buttons: 0, detail: 3 }));

      // Get selection text
      const selection = window.getSelection();
      const selectedText = selection ? selection.toString() : '';

      return {
        success: true,
        message: 'Triple-click successful',
        selectedText: selectedText.substring(0, 200),
        selectedLength: selectedText.length,
        elementInfo: {
          tagName: element.tagName,
          text: element.textContent?.trim().substring(0, 100) || ''
        }
      };
    } catch (error) {
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'clickElement') {
      // 视觉操作链路的双击消息同样携带小写 action（TOOL_MESSAGE_TYPES.CLICK_ELEMENT
      // = 'clickElement'），而 clickElement() 只实现单击——必须先分流双击到专用模拟，
      // 否则 doubleClick 会被静默降级为单击（历史缺陷）
      if (request.doubleClick && request.coordinates) {
        simulateDoubleClick(request.coordinates)
          .then(sendResponse)
          .catch((error) => {
            sendResponse({ success: false, error: error.message });
          });
        return true; // Indicates async response
      }
      clickElement(
        request.selector,
        request.waitForNavigation,
        request.timeout,
        request.coordinates,
      )
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (request.action === 'CLICK_ELEMENT') {
      // 新增：支持带坐标的单击（用于视觉操作）
      const { coordinates, doubleClick } = request;
      
      if (doubleClick) {
        simulateDoubleClick(coordinates)
          .then(sendResponse)
          .catch((error) => {
            sendResponse({ success: false, error: error.message });
          });
      } else {
        // 单击
        try {
          const element = document.elementFromPoint(coordinates.x, coordinates.y);
          if (element) {
            // 使用事件分发而不是直接调用 click()，因为某些元素（如 SVG）可能没有 click 方法
            const clickEvent = new MouseEvent('click', {
              view: window,
              bubbles: true,
              cancelable: true,
              clientX: coordinates.x,
              clientY: coordinates.y,
              button: 0,
              buttons: 1
            });
            element.dispatchEvent(clickEvent);
            
            const rect = element.getBoundingClientRect();
            sendResponse({ 
              success: true,
              message: 'Click successful',
              elementInfo: {
                tagName: element.tagName,
                text: element.textContent?.trim().substring(0, 100) || '',
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              }
            });
          } else {
            sendResponse({ success: false, error: 'Element not found at coordinates' });
          }
        } catch (error) {
          sendResponse({ success: false, error: `Error clicking element: ${error.message}` });
        }
      }
      return true;
    } else if (request.action === 'TRIPLE_CLICK') {
      // 新增：三连击支持
      simulateTripleClick(request.coordinates)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ success: false, error: error.message });
        });
      return true;
    } else if (request.action === 'chrome_click_element_ping') {
      sendResponse({ status: 'pong' });
      return false;
    }
  });
}
