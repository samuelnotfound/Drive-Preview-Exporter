// Service-worker dependencies load in order, sharing one worker scope.
importScripts(
    'background/config.js',
    'background/runtime.js',
    'background/network-capture.js',
    'background/quality-dom.js',
    'background/format-catalog.js',
    'background/video-state.js',
    'background/video-jobs.js',
    'background/quality-state.js',
    'background/quality-automation.js',
    'background/quality-scan.js',
    'background/docs-export.js',
    'background/classroom-export.js',
    'background/message-router.js',
    'background/lifecycle.js'
);
