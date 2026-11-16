// ============================================================================
// FILE: src/background/runtime.js
// PURPOSE: Low-level runtime helper functions for asynchronous delays,
//          inter-process messaging (tabs and offscreen documents), and UI badge updates.
// ============================================================================

/**
 * Creates a Promise that resolves after a specified duration in milliseconds.
 *
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sends a message from the background service worker to a specific browser tab.
 *
 * @param {number} tabId - Target tab ID
 * @param {Object} message - Serialized JSON message object
 */
const sendTab = async (tabId, message) => {
    // Guard against non-integer, undefined, or NaN tab IDs
    if (!Number.isInteger(tabId)) return;
    try {
        // Asynchronously dispatch the message to content scripts
        await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {
        // Tab may have navigated, closed, or does not have content script injected yet
    }
};

/**
 * Sends a message to the extension's offscreen document (used for MP4 remuxing / canvas).
 *
 * @param {Object} message - Payload to send to offscreen document
 */
const sendOffscreen = message => {
    try {
        // Tag with target 'video-offscreen' so only offscreen listener reacts, ignore rejection if offscreen is closed
        chrome.runtime.sendMessage({ target: 'video-offscreen', ...message }).catch?.(() => {});
    } catch (_) {
        // Extension context invalidated or service worker shutting down
    }
};

/**
 * Updates the text badge and background color on the extension action icon in Chrome toolbar.
 *
 * @param {string} text - Short string (usually 1-4 characters, e.g. "HD", "OK", "100%", or "" to clear)
 */
const setBadge = text => {
    try {
        // Set the badge text (empty string clears the badge)
        chrome.action.setBadgeText({ text });
        // Set brand green color when displaying an active badge
        if (text) chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    } catch (_) {
        // Guard against action API errors or headless test environments
    }
};
