// ============================================================================
// FILE: src/background/config.js
// PURPOSE: Central configuration constants and shared in-memory data structures
//          for background video session tracking, download jobs, and scan locks.
// ============================================================================

/**
 * Storage key under chrome.storage.session / chrome.storage.local where video sessions
 * (captured formats, active stream candidates, audio/video metadata) are persisted.
 */
const STREAM_STORE_KEY = 'videoSessions';

/**
 * Storage key under chrome.storage.session / chrome.storage.local where video stage jobs
 * (active downloads, chunk offsets, total bytes, progress) are tracked.
 */
const JOB_STORE_KEY = 'videoStageJobs';

/**
 * In-memory map of active stream capture states per tab.
 * Key: tabId (number), Value: { recentStreams: Array, probeBuffer: Array, activeProbe: Object, ... }
 */
const STREAM_CAPTURE_TABS = new Map();

/**
 * In-memory concurrency lock preventing simultaneous quality scans on the same tab.
 * Key: tabId (number), Value: { promise: Promise, finishedAt: number }
 *
 * PURPOSE:
 * Prevents race conditions where two simultaneous UI actions attempt to automate
 * the Drive player's Settings -> Quality menu at the exact same moment.
 */
const QUALITY_SCAN_TAB_LOCK = new Map();

/**
 * Timing configurations for quality probing.
 */
const FAST_SCAN = Object.freeze({
    streamWaitMs: 1500,
});
