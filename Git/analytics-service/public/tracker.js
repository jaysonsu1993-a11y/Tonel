/**
 * tonel-analytics tracker
 * Drop-in <script> for the public site.
 *
 * Usage in HTML:
 *   <script src="https://analytics.tonel.io/tracker.js"
 *           data-endpoint="https://analytics.tonel.io"
 *           defer></script>
 *
 * Or load programmatically and call window.tonelTrack() on SPA route changes.
 *
 * Behaviour:
 *  - On load, send one POST /api/track with {path, referrer, session_id}.
 *  - Falls back to <img src=/api/track.gif> beacon if fetch is unavailable
 *    or blocked by an extension.
 *  - Persists a 32-char session_id in sessionStorage (resets on tab close).
 *  - Auto-tracks SPA route changes by patching pushState/replaceState
 *    and listening for popstate.
 */
(function () {
    var script = document.currentScript || (function () {
        var s = document.getElementsByTagName('script');
        return s[s.length - 1];
    })();
    var ENDPOINT = (script && script.getAttribute('data-endpoint'))
        || (location.protocol + '//' + location.host);

    function sessionId() {
        try {
            var k = 'tonel_an_sid';
            var v = sessionStorage.getItem(k);
            if (!v) {
                v = (Date.now().toString(36) +
                     Math.random().toString(36).slice(2, 10));
                sessionStorage.setItem(k, v);
            }
            return v;
        } catch (_) { return ''; }
    }

    function send(payload) {
        var url = ENDPOINT.replace(/\/$/, '') + '/api/track';
        try {
            if (window.fetch) {
                fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true,
                    mode: 'cors',
                    credentials: 'omit',
                }).catch(beacon);
                return;
            }
        } catch (_) {}
        beacon(payload);
    }

    function beacon(payload) {
        var p = typeof payload === 'object' ? payload : {};
        var qs = Object.keys(p).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(p[k] || '');
        }).join('&');
        var img = new Image(1, 1);
        img.src = ENDPOINT.replace(/\/$/, '') + '/api/track.gif?' + qs;
    }

    function track() {
        send({
            path: location.pathname + location.search,
            referrer: document.referrer || '',
            session_id: sessionId(),
        });
    }

    // Patch SPA routing so we get an event on every pushState/replaceState.
    function wrap(name) {
        var orig = history[name];
        if (!orig) return;
        history[name] = function () {
            var ret = orig.apply(this, arguments);
            try { track(); } catch (_) {}
            return ret;
        };
    }
    wrap('pushState'); wrap('replaceState');
    window.addEventListener('popstate', track);

    // Expose for manual calls (custom events, modal open, etc.).
    window.tonelTrack = track;

    // Initial pageview.
    if (document.readyState === 'complete') track();
    else window.addEventListener('load', track);
})();
