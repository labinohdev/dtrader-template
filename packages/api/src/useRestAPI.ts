import React from 'react';
import { getAppId } from '@deriv/shared';
import { APIContext } from './APIProvider';

const AUTH_INFO_KEY = 'auth_info';

// [AI] Parent-domain cookie config — duplicated from core/Services/oauth.ts
// because packages/api cannot import from packages/core (would be a circular
// dependency). Keep these constants in sync if oauth.ts changes them.
const TK_COOKIE_NAME = 'tk_auth';
const TK_COOKIE_DOMAIN = '.tradekintra.com';

const isProductionHost = (): boolean => {
    return typeof window !== 'undefined' && /tradekintra\.com$/.test(window.location.hostname);
};

const readAuthCookie = (): { access_token: string; expires_at?: number | null } | null => {
    if (typeof document === 'undefined') return null;
    try {
        const match = document.cookie.split(';').find(c => c.trim().startsWith(`${TK_COOKIE_NAME}=`));
        if (!match) return null;
        const value = decodeURIComponent(match.split('=').slice(1).join('='));
        const info = JSON.parse(value);
        if (info.expires_at && Date.now() >= info.expires_at) return null;
        return info;
    } catch {
        return null;
    }
};

const getStoredToken = (): string | null => {
    try {
        // First check sessionStorage (current-tab session, fastest path)
        const info = JSON.parse(sessionStorage.getItem(AUTH_INFO_KEY) ?? 'null');
        if (info) {
            if (info.expires_at && Date.now() >= info.expires_at) {
                sessionStorage.removeItem(AUTH_INFO_KEY);
                return null;
            }
            return info.access_token ?? null;
        }
        // [AI] Fallback: read parent-domain cookie for cross-subdomain SSO.
        // Hydrate sessionStorage so subsequent calls in this tab are fast.
        if (isProductionHost()) {
            const cookieInfo = readAuthCookie();
            if (cookieInfo?.access_token) {
                sessionStorage.setItem(AUTH_INFO_KEY, JSON.stringify(cookieInfo));
                return cookieInfo.access_token;
            }
        }
        return null;
    } catch {
        return null;
    }
};

/**
 * Hook to access REST API configuration from APIProvider
 * Provides centralized REST API base URL and fetch helper
 */
export const useRestAPI = () => {
    const context = React.useContext(APIContext);
    if (!context) {
        throw new Error('useRestAPI must be used within APIProvider');
    }
    const { restAPIConfig } = context;
    /**
     * Generic fetch wrapper with auth headers
     * @param endpoint - API endpoint path (e.g., '/trading/v1/options/accounts')
     * @param options - Optional fetch options
     * @returns Promise with typed response
     */
    const fetchREST = async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
        const url = `${restAPIConfig.baseUrl}${endpoint}`;
        // Determine the method (default to GET if not specified)
        const method = options?.method || 'GET';
        // Only set Content-Type for methods that have a body
        const shouldSetContentType = ['POST', 'PUT', 'PATCH'].includes(method);
        const token = getStoredToken();
        const authHeaders: Record<string, string> = token
            ? { Authorization: `Bearer ${token}`, 'Deriv-App-ID': String(getAppId()) }
            : {};
        const response = await fetch(url, {
            ...options,
            method,
            headers: {
                ...authHeaders,
                ...(shouldSetContentType && { 'Content-Type': 'application/json' }),
                ...options?.headers,
            },
        });
        if (!response.ok) {
            // Try to parse error body for more detailed error information
            let errorBody;
            try {
                errorBody = await response.json();
            } catch {
                // If response body is not JSON, use generic error
                errorBody = null;
            }
            // Extract error message from API response if available
            const errorMessage =
                errorBody?.errors?.[0]?.message || `REST API Error: ${response.status} ${response.statusText}`;
            const errorCode = errorBody?.errors?.[0]?.code;
            // Create enhanced error with additional properties
            const error = new Error(errorMessage) as Error & {
                status: number;
                statusText: string;
                code?: string;
                body?: unknown;
                isAuthError: boolean;
            };
            error.status = response.status;
            error.statusText = response.statusText;
            error.code = errorCode;
            error.body = errorBody;
            error.isAuthError = response.status === 401 || response.status === 403;
            throw error;
        }
        const data = await response.json();
        return data;
    };
    return {
        baseUrl: restAPIConfig.baseUrl,
        fetchREST,
    };
};