/* Shared by the service worker and offscreen downloader. Keep signed URL bytes intact. */
(() => {
    function withoutRange(url) {
        if (!url) return url;
        const value = String(url);
        const hashIndex = value.indexOf('#');
        const fragment = hashIndex < 0 ? '' : value.slice(hashIndex);
        const resource = hashIndex < 0 ? value : value.slice(0, hashIndex);
        const queryIndex = resource.indexOf('?');
        if (queryIndex < 0) return value;
        const params = resource.slice(queryIndex + 1).split('&');
        const kept = params.filter(param => !/^range(?:=|$)/i.test(param));
        if (kept.length === params.length) return value;
        return resource.slice(0, queryIndex) + (kept.length ? '?' + kept.join('&') : '') + fragment;
    }

    function withRange(url, start, end) {
        const value = withoutRange(url);
        const hashIndex = value.indexOf('#');
        const fragment = hashIndex < 0 ? '' : value.slice(hashIndex);
        const resource = hashIndex < 0 ? value : value.slice(0, hashIndex);
        const separator = resource.includes('?') ? (/[?&]$/.test(resource) ? '' : '&') : '?';
        return `${resource}${separator}range=${start}-${end}${fragment}`;
    }

    globalThis.GDriveStreamURL = Object.freeze({ withoutRange, withRange });
})();
