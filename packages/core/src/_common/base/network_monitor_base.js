const { localize } = require('@deriv-com/translations');
const BinarySocket = require('./socket_base');

/*
 * Monitors the network status and initialises the WebSocket connection
 * 1. online : check the WS status (init/send: blink after timeout, open/message: online)
 * 2. offline: it is offline
 */
const NetworkMonitorBase = (() => {
    // [AI] Module-level reference to client_store so reconnectAfter() can call
    // refreshSocketAuth() — needed to fetch a fresh OTP before each reconnect.
    // Stale OTPs are single-use and rejected by the server, causing the
    // "Connection failed. Please refresh." error on idle/background reconnect.
    let client_store_ref = null;

    // [AI] Guard against runaway reconnect loops if refreshSocketAuth keeps
    // failing (e.g. backend OTP endpoint down). After MAX_AUTH_RETRIES failures,
    // fall back to public reconnect so the user at least sees a degraded but
    // functional experience instead of hammering the OTP endpoint forever.
    const MAX_AUTH_RETRIES = 3;
    let auth_retry_count = 0;

    // Use getter functions to ensure localize() is called when needed, not at module init
    const getStatusConfig = status => {
        const configs = {
            online: { class: 'online', tooltip: localize('Online') },
            offline: { class: 'offline', tooltip: localize('Offline') },
            blinking: { class: 'blinker', tooltip: localize('Connecting to server') },
        };
        return configs[status];
    };

    let setNetworkStatus;

    const init = (socket_general_functions, fncUpdateUI, client_store) => {
        // [AI] Store client_store reference for use in reconnectAfter()
        client_store_ref = client_store;

        let last_status, last_is_online;
        setNetworkStatus = status => {
            const is_online = isOnline();
            if (status !== last_status || is_online !== last_is_online) {
                last_status = status;
                last_is_online = is_online;
                fncUpdateUI(getStatusConfig(status), is_online);
            }
        };

        if ('onLine' in navigator) {
            window.addEventListener('online', () => {
                setNetworkStatus('blinking');
                reconnectAfter({ timeout: 500 });
            });
            window.addEventListener('offline', () => {
                BinarySocket.close();
                setNetworkStatus('offline');
            });
        } else {
            // default to always online and fallback to WS checks
            navigator.onLine = true;
        }

        if (isOnline()) {
            const ws_config = { wsEvent, isOnline, ...socket_general_functions };
            BinarySocket.init({ options: ws_config, client: client_store });

            // If a token exists, skip the public connection — client_store.init() will
            // fetch an OTP and open an authenticated connection instead.
            const has_token = !!JSON.parse(sessionStorage.getItem('auth_info') ?? 'null')?.access_token;
            if (!has_token) {
                BinarySocket.openNewConnection();
            }
        }

        setNetworkStatus(isOnline() ? 'blinking' : 'offline');
    };

    const isOnline = () => navigator.onLine;

    // reconnect after timout,
    // if the network status is online
    // and the connection is closed or closing.
    let reconnect_timeout = null;
    function reconnectAfter({ timeout }) {
        clearTimeout(reconnect_timeout);
        reconnect_timeout = setTimeout(async () => {
            reconnect_timeout = null;
            if (!isOnline()) return;

            // If the socket isn't actually closed yet, just nudge it with a ping
            // so we get a fresh status sooner.
            if (!BinarySocket.hasReadyState(2, 3)) {
                BinarySocket.send({ time: 1 });
                return;
            }

            // [AI] Critical fix for stale-OTP reconnect bug:
            // The original code called BinarySocket.openNewConnection() here, which
            // reuses the cached `configured_ws_url` — an OTP-embedded URL that the
            // server rejects on second use. Result: infinite reconnect failures
            // and the user sees "Connection failed. Please refresh."
            //
            // Fix: if a client_store reference is available, delegate to
            // refreshSocketAuth() which fetches a fresh OTP (when logged in) or
            // reconnects to the public endpoint (when logged out). Falls back to
            // the legacy behavior if client_store_ref isn't wired (e.g. before
            // init completes, or in test environments).
            if (client_store_ref && typeof client_store_ref.refreshSocketAuth === 'function') {
                try {
                    await client_store_ref.refreshSocketAuth();
                    // Success — reset the retry counter for the next disconnect cycle.
                    auth_retry_count = 0;
                } catch (err) {
                    auth_retry_count++;
                    // eslint-disable-next-line no-console
                    console.error(
                        `[NetworkMonitor] refreshSocketAuth failed (attempt ${auth_retry_count}/${MAX_AUTH_RETRIES}):`,
                        err
                    );
                    if (auth_retry_count >= MAX_AUTH_RETRIES) {
                        // Give up on auth refresh — fall back to public reconnect so the
                        // user at least sees market data and can manually re-login.
                        auth_retry_count = 0;
                        BinarySocket.setWSUrl(null);
                        BinarySocket.openNewConnection();
                    }
                    // Otherwise: socket stays closed; next disconnect event or manual
                    // refresh will trigger another attempt.
                }
            } else {
                // No client_store wired — legacy behavior (public endpoint).
                BinarySocket.openNewConnection();
            }
        }, timeout);
    }
    const events = {
        init: () => setNetworkStatus(isOnline() ? 'blinking' : 'offline'),
        open: () => setNetworkStatus(isOnline() ? 'online' : 'offline'),
        send: () => {},
        message: () => setNetworkStatus('online'),
        close: () => {
            setNetworkStatus(isOnline() ? 'blinking' : 'offline');
            reconnectAfter({ timeout: 5000 });
        },
    };

    const wsEvent = event => {
        events[event] && events[event](); // eslint-disable-line
    };

    return {
        init,
        wsEvent,
    };
})();

module.exports = NetworkMonitorBase;