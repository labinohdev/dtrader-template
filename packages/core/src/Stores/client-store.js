import Cookies from 'js-cookie';
import { action, computed, makeObservable, observable, reaction, runInAction, when } from 'mobx';
import moment from 'moment';

import {
    filterUrlQuery,
    getAccountType,
    getTrustedDomainName,
    isCryptocurrency,
    LocalStore,
    removeCookies,
    routes,
    SessionStore,
    urlForLanguage,
} from '@deriv/shared';
import { getInitialLanguage, localize } from '@deriv-com/translations';

import { requestRestLogout, WS } from 'Services';
import { fetchAccounts, fetchOTP } from '../Services/accounts-api';
import { clearTokens, generateOAuthURL, getStoredToken } from '../Services/oauth';

import { getClientAccountType } from './Helpers/client';
import { buildCurrenciesList } from './Modules/Trading/Helpers/currency';
import BaseStore from './base-store';

import BinarySocket from '_common/base/socket_base';
import { getRegion, isMultipliersOnly, isOptionsBlocked } from '_common/utility';

const LANGUAGE_KEY = 'i18n_language';
const storage_key = 'current_account';
const store_name = 'client_store';

export default class ClientStore extends BaseStore {
    loginid;
    preferred_language;
    email;
    user_id;
    external_id;

    current_account = null;
    initialized_broadcast = false;
    is_authorize = false;
    is_logging_in = false;
    is_client_store_initialized = false;
    has_logged_out = false;
    should_redirect_user_to_login = false;
    is_new_session = false;

    currencies_list = {};
    selected_currency = '';

    has_cookie_account = false;
    tab_visibility_handler = null;

    constructor(root_store) {
        const local_storage_properties = [];
        super({ root_store, local_storage_properties, store_name });

        makeObservable(this, {
            loginid: observable,
            preferred_language: observable,
            email: observable,
            user_id: observable,
            current_account: observable,
            initialized_broadcast: observable,
            currencies_list: observable,
            selected_currency: observable,
            is_authorize: observable,
            is_logging_in: observable,
            is_client_store_initialized: observable,
            has_logged_out: observable,
            should_redirect_user_to_login: observable,
            has_cookie_account: observable,
            is_new_session: observable,

            balance: computed,
            currency: computed,
            is_virtual: computed,
            is_eu: computed,
            is_logged_in: computed,
            account_type: computed,
            default_currency: computed,
            residence: computed,
            email_address: computed,
            landing_company_shortcode: computed,

            is_cr_account: computed,
            is_mf_account: computed,
            is_options_blocked: computed,
            is_multipliers_only: computed,

            has_active_real_account: computed,
            has_any_real_account: computed,
            is_single_currency: computed,

            setPreferredLanguage: action.bound,
            setCookieAccount: action.bound,
            responsePayoutCurrencies: action.bound,
            responseAuthorize: action.bound,
            setLoginId: action.bound,
            setIsAuthorize: action.bound,
            setIsLoggingIn: action.bound,
            setBalanceActiveAccount: action.bound,
            selectCurrency: action.bound,
            setEmail: action.bound,
            setInitialized: action.bound,
            setIsClientStoreInitialized: action.bound,
            cleanUp: action.bound,
            logout: action.bound,
            setLogout: action.bound,
            setShouldRedirectToLogin: action.bound,
            init: action.bound,
            resetVirtualBalance: action.bound,
            is_crypto: action.bound,
            switchAccount: action.bound,
            // [AI] Registered so MobX treats it as an action — invoked from
            // NetworkMonitorBase.reconnectAfter() to refresh the OTP-embedded
            // WebSocket URL before each reconnect attempt.
            refreshSocketAuth: action.bound,
        });

        reaction(
            () => [this.is_logged_in, this.loginid, this.email, this.currency, this.preferred_language],
            () => {
                this.setCookieAccount();
            }
        );

        when(
            () => !this.is_logged_in && this.root_store.ui && this.root_store.ui.is_real_acc_signup_on,
            () => this.root_store.ui.closeRealAccountSignup()
        );
    }

    get balance() {
        if (this.current_account?.balance !== undefined && this.current_account?.balance !== null) {
            return this.current_account.balance.toString();
        }
        return undefined;
    }

    get has_active_real_account() {
        return !this.is_virtual;
    }

    get has_any_real_account() {
        return !this.is_virtual;
    }

    get currency() {
        if (this.selected_currency.length) {
            return this.selected_currency;
        }
        return this.current_account?.currency || this.default_currency;
    }

    is_crypto(currency) {
        return isCryptocurrency(currency || this.currency);
    }

    get default_currency() {
        if (Object.keys(this.currencies_list).length > 0) {
            const keys = Object.keys(this.currencies_list);
            if (this.currencies_list[localize('Fiat')]?.length < 1) return 'USD';
            return Object.values(this.currencies_list[`${keys[0]}`])[0].text;
        }
        return 'USD';
    }

    get is_logged_in() {
        const hasToken = !!getStoredToken();
        const hasCurrentAccountLoginId = !!this.current_account?.loginid;
        const hasLoginId = !!this.loginid;
        return hasToken && hasCurrentAccountLoginId && hasLoginId;
    }

    get is_virtual() {
        // Reference loginid to make this computed reactive to account switches
        this.loginid;
        return getAccountType() === 'demo';
    }

    get is_eu() {
        return this.landing_company_shortcode === 'maltainvest';
    }

    get account_type() {
        return getClientAccountType(this.loginid);
    }

    get residence() {
        return this.current_account?.residence || '';
    }

    get email_address() {
        return this.current_account?.email || '';
    }

    get landing_company_shortcode() {
        // Default to 'svg' for ROW behavior (maximum permissiveness)
        return this.current_account?.landing_company_shortcode || 'svg';
    }

    get is_cr_account() {
        return this.loginid?.startsWith('CR');
    }

    get is_mf_account() {
        return this.loginid?.startsWith('MF');
    }

    get is_options_blocked() {
        return isOptionsBlocked(this.residence);
    }

    get is_multipliers_only() {
        return isMultipliersOnly(this.residence);
    }

    get is_single_currency() {
        return true; // Simplified for single account
    }

    setIsAuthorize(value) {
        this.is_authorize = value;
    }

    setPreferredLanguage = lang => {
        this.preferred_language = lang;
        LocalStore.setObject(LANGUAGE_KEY, lang);
    };

    setCookieAccount() {
        const domain = getTrustedDomainName();

        const { loginid, landing_company_shortcode, currency, preferred_language, user_id } = this;
        const email = this.email;
        const residence = this.residence;

        if (loginid && email) {
            const client_information = {
                loginid,
                email,
                landing_company_shortcode,
                currency,
                residence,
                preferred_language,
                user_id,
            };
            Cookies.set('region', getRegion(landing_company_shortcode, residence), { domain });
            Cookies.set('client_information', client_information, { domain });
            this.has_cookie_account = true;
        } else {
            removeCookies('region', 'client_information');
            this.has_cookie_account = false;
        }
    }

    responsePayoutCurrencies(response) {
        // Since payout_currencies endpoint has been removed, use USD as fallback
        const list = response?.payout_currencies || response || ['USD'];
        this.currencies_list = buildCurrenciesList(Array.isArray(list) ? list : ['USD']);
        this.selectCurrency('');
    }

    responseAuthorize(response) {
        const { authorize } = response;

        runInAction(() => {
            this.current_account = {
                loginid: authorize.loginid,
                balance: authorize.balance,
                currency: authorize.currency,
                email: authorize.email || '',
                landing_company_shortcode: authorize.landing_company_name || '',
                residence: authorize.country || '',
                session_start: parseInt(moment().utc().valueOf() / 1000),
            };

            this.setLoginId(authorize.loginid);
        });

        this.user_id = authorize.user_id || '';
        if (this.user_id) {
            localStorage.setItem('active_user_id', this.user_id);
        }

        // Store active_loginid for backward compatibility with notification system and multi-tab sync
        localStorage.setItem('active_loginid', authorize.loginid);
        sessionStorage.setItem('active_loginid', authorize.loginid);

        // Store current account
        localStorage.setItem(storage_key, JSON.stringify(this.current_account));
    }

    async resetVirtualBalance() {
        this.root_store.notifications.removeNotificationByKey({ key: 'reset_virtual_balance' });
        this.root_store.notifications.removeNotificationMessage({
            key: 'reset_virtual_balance',
            should_show_again: true,
        });
        await WS.authorized.topupVirtual();
    }

    isAccountOfType = type => {
        const client_account_type = getClientAccountType(this.loginid);
        return (
            (type === 'virtual' && client_account_type === 'virtual') ||
            (type === 'real' && client_account_type !== 'virtual') ||
            type === client_account_type
        );
    };

    async init(external_id) {
        // [AI] Cross-subdomain SSO via URL token. The bot appends
        // ?tk_token=<access_token> when linking back to the trader. Mobile
        // browsers block the shared cookie, but URL params always carry over.
        // Read it, store it in sessionStorage as auth_info, then strip it from
        // the URL. Done before removeTokenFromUrl / getStoredToken so the rest
        // of init() sees the session as authenticated.
        try {
            const url = new URL(window.location.href);
            const tk_token = url.searchParams.get('tk_token');
            if (tk_token) {
                const existing = sessionStorage.getItem('auth_info');
                if (!existing) {
                    sessionStorage.setItem(
                        'auth_info',
                        JSON.stringify({
                            access_token: tk_token,
                            refresh_token: undefined,
                            expires_at: null,
                        })
                    );
                }
                url.searchParams.delete('tk_token');
                window.history.replaceState({}, document.title, url.toString());
            }
        } catch (e) {
            // URL parse failed — non-fatal, fall through to cookie/session
        }

        // Remove any legacy token parameters from URL
        this.removeTokenFromUrl();

        let search = '';
        try {
            search = SessionStore?.get?.('signup_query_param') || window?.location?.search || '';
        } catch (error) {
            search = '';
        }

        const search_params = new URLSearchParams(search);
        const redirect_url = search_params?.get('redirect_url');
        const action_param = search_params?.get('action');
        const loginid_param = search_params?.get('loginid');

        if (getStoredToken()) {
            // Set is_logging_in to true while we wait for authorization
            this.setIsLoggingIn(true);

            // Step 5 of OAuth flow: fetch accounts → pick active account → get OTP WS URL.
            // The OTP URL embeds auth — once the socket opens and subscribes to balance,
            // socket-general.js calls authorizeAccount() which completes the login.
            try {
                const accounts = await fetchAccounts();
                const active_account =
                    accounts.find(a => a.account_id === sessionStorage.getItem('active_loginid')) ||
                    accounts.find(a => a.account_type === 'demo') ||
                    accounts[0];

                if (!active_account) throw new Error('No accounts found');

                sessionStorage.setItem('active_loginid', active_account.account_id);
                localStorage.setItem('active_loginid', active_account.account_id);
                localStorage.setItem('account_type', active_account.account_type);

                const ws_url = await fetchOTP(active_account.account_id);
                BinarySocket.setWSUrl(ws_url);
                BinarySocket.closeAndOpenNewConnection();

                // Wait for balance response which serves as authorization.
                // socket-general.js processes the balance response and calls authorizeAccount().
                await BinarySocket.wait('balance');
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('[Auth] Account init failed:', error);
                clearTokens();
            }
        }

        // Handle special action parameters and user_id for both logged-in and logged-out states
        if (
            ['crypto_transactions_withdraw', 'payment_withdraw', 'payment_agent_withdraw'].includes(action_param) &&
            loginid_param
        ) {
            this.setLoginId(loginid_param);
        } else {
            this.setLoginId(window.sessionStorage.getItem('active_loginid') || LocalStore.get('active_loginid'));
        }

        this.user_id = LocalStore.get('active_user_id');

        // Load current account from localStorage if not already set
        if (!this.current_account) {
            const stored_account = LocalStore.getObject(storage_key);
            if (stored_account) {
                this.current_account = stored_account;
            }
        }

        this.external_id = external_id;

        // Handle redirect and language settings for logged-in users
        if (this.is_logged_in) {
            if (redirect_url) {
                const redirect_route = routes[redirect_url].length > 1 ? routes[redirect_url] : '';
                const has_action = [
                    'crypto_transactions_withdraw',
                    'payment_agent_withdraw',
                    'payment_withdraw',
                    'reset_password',
                ].includes(action_param);

                if (has_action) {
                    const query_string = filterUrlQuery(search, ['platform', 'code', 'action', 'loginid']);
                    window.location.replace(`${redirect_route}/redirect?${query_string}`);
                } else {
                    window.location.replace(`${redirect_route}/?${filterUrlQuery(search, ['platform', 'lang'])}`);
                }
            }

            const language = this.current_account?.preferred_language || getInitialLanguage();
            const stored_language_without_double_quotes = LocalStore.get(LANGUAGE_KEY).replace(/"/g, '');
            if (stored_language_without_double_quotes && language !== stored_language_without_double_quotes) {
                window.history.replaceState({}, document.title, urlForLanguage(language));
                await this.root_store.common.changeSelectedLanguage(language);
            }
        }

        this.selectCurrency('');

        // Since payout_currencies endpoint has been removed, use USD as default
        this.responsePayoutCurrencies(['USD']);

        this.setIsLoggingIn(false);
        this.setInitialized(true);

        // Clean up URL parameters
        if (action_param === 'signup') {
            const filteredQuery = filterUrlQuery(search, ['lang']);
            history.replaceState(
                null,
                null,
                window.location.href.replace(`${search}`, filteredQuery === '' ? '' : `?${filteredQuery}`)
            );
        }

        this.setIsClientStoreInitialized();

        // Set up visibility change listener to check whoami when tab becomes visible
        this.setupVisibilityListener();

        return true;
    }

    /**
     * Sets up a visibility change listener: if the token has expired while the
     * tab was hidden, log the user out and redirect to OAuth login.
     */
    setupVisibilityListener() {
        this.removeVisibilityListener();

        this.tab_visibility_handler = () => {
            if (document.visibilityState === 'visible' && !getStoredToken() && this.is_logged_in) {
                // Token expired while tab was hidden — redirect to fresh OAuth login
                generateOAuthURL().then(url => window.location.replace(url));
            }
        };

        document.addEventListener('visibilitychange', this.tab_visibility_handler);
    }

    /**
     * Removes the visibility change listener
     */
    removeVisibilityListener() {
        if (this.tab_visibility_handler) {
            document.removeEventListener('visibilitychange', this.tab_visibility_handler);
            this.tab_visibility_handler = null;
        }
    }

    setLoginId(loginid) {
        this.loginid = loginid;
    }

    setIsLoggingIn(bool) {
        this.is_logging_in = bool;
    }

    setBalanceActiveAccount(obj_balance) {
        if (!obj_balance || typeof obj_balance.balance === 'undefined') {
            return;
        }

        if (this.current_account && obj_balance.loginid === this.current_account.loginid) {
            this.current_account.balance = obj_balance.balance;

            if (this.is_virtual) {
                this.root_store.notifications.resetVirtualBalanceNotification(this.current_account.loginid);
            }

            // Update localStorage
            localStorage.setItem(storage_key, JSON.stringify(this.current_account));
        }
    }

    selectCurrency(value) {
        this.selected_currency = value;
    }

    setEmail(email) {
        if (this.current_account) {
            this.current_account.email = email;
            this.email = email;
        }
    }

    setIsClientStoreInitialized() {
        this.is_client_store_initialized = true;
    }

    setInitialized(is_initialized) {
        this.initialized_broadcast = is_initialized;
    }

    async cleanUp() {
        // Remove visibility listener
        this.removeVisibilityListener();

        // Clean up notifications
        const notification_messages = LocalStore.getObject('notification_messages');
        if (notification_messages && this.loginid) {
            delete notification_messages[this.loginid];
            LocalStore.setObject('notification_messages', { ...notification_messages });
        }

        // Reset state
        this.loginid = null;
        this.user_id = null;
        this.external_id = null;
        this.current_account = null;

        LocalStore.set('marked_notifications', JSON.stringify([]));
        localStorage.setItem('active_loginid', this.loginid);
        sessionStorage.removeItem('active_loginid');
        localStorage.setItem('active_user_id', this.user_id);
        localStorage.setItem(storage_key, JSON.stringify(this.current_account));

        // Clear OAuth tokens and reset WS to public endpoint
        clearTokens();
        BinarySocket.setWSUrl(null);

        runInAction(() => {
            // Since payout_currencies endpoint has been removed, use USD as default
            this.responsePayoutCurrencies(['USD']);
        });
        this.root_store.notifications.removeAllNotificationMessages(true);

        // Drop WebSocket connection and reconnect to public endpoint
        BinarySocket.closeAndOpenNewConnection();
    }

    setShouldRedirectToLogin(should_redirect_user_to_login) {
        this.should_redirect_user_to_login = should_redirect_user_to_login;
    }

    async logout() {
        const response = await requestRestLogout();

        if (response?.logout === 1) {
            await this.cleanUp();
            this.setLogout(true);
        }

        return response;
    }

    setLogout(is_logged_out) {
        this.has_logged_out = is_logged_out;
        if (this.root_store.common.has_error) this.root_store.common.setError(false, null);
    }

    removeTokenFromUrl() {
        const url = new URL(window.location.href);
        if (url.searchParams.has('token')) {
            url.searchParams.delete('token');
            window.history.replaceState({}, document.title, url.toString());
        }
    }

    /**
     * [AI] Refresh the WebSocket authentication for the CURRENT account.
     *
     * Called by NetworkMonitorBase.reconnectAfter() when the socket has been
     * closed (idle timeout, network drop, mobile background, etc.) and needs
     * to be reopened.
     *
     * The original reconnect logic blindly reused the cached OTP WS URL, but
     * OTPs are single-use — the server rejects them on the second connection
     * attempt, producing the "Connection failed. Please refresh this page to
     * continue." error users hit after going idle or backgrounding the app.
     *
     * Fix: fetch a fresh OTP, update the socket URL, then reconnect. For
     * logged-out sessions, reconnect cleanly to the public endpoint.
     *
     * @throws if logged in but fetchOTP fails — the caller (NetworkMonitorBase)
     *         tracks retry counts and falls back to public after MAX_AUTH_RETRIES.
     */
    async refreshSocketAuth() {
        const has_token = !!getStoredToken();
        if (!has_token || !this.loginid) {
            // Logged out — reconnect to public endpoint cleanly
            BinarySocket.setWSUrl(null);
            BinarySocket.openNewConnection();
            return;
        }

        // Logged in — fetch a fresh OTP for the current account.
        // OTP URLs are single-use and embed the account ID, so we must mint a
        // new one each reconnect.
        const ws_url = await fetchOTP(this.loginid);
        BinarySocket.setWSUrl(ws_url);
        BinarySocket.closeAndOpenNewConnection();
    }

    /**
     * Switch to a different account.
     * Updates loginid, fetches a fresh OTP, and reconnects the WebSocket.
     * @param {string} account_id - The account ID to switch to
     */
    async switchAccount(account_id) {
        if (!account_id || this.loginid === account_id) return;

        // Track the newly active account for multi-tab sync
        localStorage.setItem('active_loginid', account_id);
        sessionStorage.setItem('active_loginid', account_id);

        // Update account_type so is_virtual computed reflects the switched account immediately.
        // DEM-prefixed IDs are demo accounts; all others are real.
        const switched_account_type = account_id.startsWith('DEM') ? 'demo' : 'real';
        localStorage.setItem('account_type', switched_account_type);

        // Update the store's loginid immediately so components don't render stale data
        // while waiting for the balance response to arrive.
        this.setLoginId(account_id);

        // Clear notifications when switching accounts (similar to old implementation)
        this.root_store.notifications.removeNotifications(true);
        this.root_store.notifications.removeTradeNotifications();
        this.root_store.notifications.removeAllNotificationMessages(true);

        // Clear contract markers to prevent showing previous account's contracts on chart
        this.root_store.contract_trade.clearContracts();

        // Fetch a fresh OTP for the new account — OTP URLs are single-use and
        // embed the account ID, so reusing the old URL would connect to the wrong account.
        try {
            const ws_url = await fetchOTP(account_id);
            BinarySocket.setWSUrl(ws_url);
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('[Auth] Failed to fetch OTP for account switch:', error);
        }

        BinarySocket.closeAndOpenNewConnection();
    }
}