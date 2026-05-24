import React from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';

import { useDerivativesAccount, useMobileBridge } from '@deriv/api';
import { Button, Skeleton, Text } from '@deriv/components';
import { useStore } from '@deriv/stores';
import { redirectToSignUp } from '@deriv/shared';
import { useTranslations } from '@deriv-com/translations';

import { LoginButton } from './login-button';

import 'Sass/app/_common/components/account-switcher.scss';

const AccountInfo = React.lazy(
    () =>
        import(/* webpackChunkName: "account-info", webpackPreload: true */ 'App/Components/Layout/Header/account-info')
);

const AccountActionsComponent = observer(() => {
    const { client, common, ui } = useStore();
    const { currency, is_logged_in, loginid } = client;
    const { is_switching_account, setIsSwitchingAccount } = ui;

    const { localize } = useTranslations();
    const { sendBridgeEvent } = useMobileBridge();

    // Fetch derivatives accounts to determine button type (single source of truth)
    const { data, isLoading, error, refetch } = useDerivativesAccount(loginid, is_logged_in);
    const accounts = data?.data || [];

    // Handle account switch start
    const handleAccountSwitchStart = React.useCallback(() => {
        setIsSwitchingAccount(true);
    }, [setIsSwitchingAccount]);

    // Reset switching state when loading completes with either data or error
    React.useEffect(() => {
        if (!isLoading && (accounts.length > 0 || error)) {
            setIsSwitchingAccount(false);
        }
    }, [isLoading, accounts, error, setIsSwitchingAccount]);

    // Determine account types available
    const hasOnlyDemoAccounts = accounts.length > 0 && accounts.every(acc => acc.account_type === 'demo');

    // Button logic:
    // - If only demo accounts exist -> show "Try real"
    // - Otherwise (real only or both real and demo) -> show "Deposit"
    const buttonLabel = hasOnlyDemoAccounts ? localize('Try real') : localize('Deposit');

    const handleTransferClick = () => {
        if (hasOnlyDemoAccounts) {
            // Show modal instead of redirecting directly
            ui.toggleTryRealModal(true);
        } else {
            // [AI] Deposit opens Deriv's cashier in a new tab (Tradekintra has no
            // built-in cashier yet). Per Amy at Deriv: cashier has no return_url
            // parameter, so we open in a new tab and let the user close it when
            // done. They land back on tradekintra.com automatically.
            // Future work: build M-Pesa deposit on tradekintra.com for Kenyan
            // market differentiation, plus subscribe to balance/transaction WS
            // to show "Continue trading" prompt when funds arrive.
            sendBridgeEvent('trading:transfer', () => {
                const lang_param = common.current_language ? `&lang=${common.current_language}` : '';
                window.open(
                    `https://cashier.deriv.com/?source=tradekintra&curr=${currency}${lang_param}`,
                    '_blank',
                    'noopener,noreferrer'
                );
            });
        }
    };

    const renderAccountInfo = () => (
        <React.Suspense fallback={<div />}>
            <AccountInfo
                accounts={accounts}
                isLoading={isLoading}
                error={error}
                refetch={refetch}
                onAccountSwitch={handleAccountSwitchStart}
            />
            <Button
                className='acc-info__transfer-button'
                onClick={handleTransferClick}
                aria-label={buttonLabel}
                type='button'
                has_effect
            >
                <Text size='xs' weight='bold' color='white'>
                    {buttonLabel}
                </Text>
            </Button>
        </React.Suspense>
    );

    if (!is_logged_in) {
        return (
            <div
                id='dt_core_header_acc-info-container'
                className={classNames('acc-info__container', {
                    'acc-info__container--logged-out': !is_logged_in,
                })}
            >
                <Button
                    id='dt_signup_button'
                    className='acc-info__button'
                    has_effect
                    text={localize('Sign up')}
                    onClick={() => redirectToSignUp()}
                    secondary
                />
                <LoginButton className='acc-info__button' />
            </div>
        );
    }

    const shouldShowLoader = isLoading || is_switching_account;

    return (
        <div
            id='dt_core_header_acc-info-container'
            className={classNames('acc-info__container', {
                'acc-info__container--loading': shouldShowLoader,
            })}
        >
            {shouldShowLoader ? (
                <React.Fragment>
                    <Skeleton height={32} width={120} borderRadius={16} />
                    <Skeleton height={32} width={80} borderRadius={16} />
                </React.Fragment>
            ) : (
                renderAccountInfo()
            )}
        </div>
    );
});

AccountActionsComponent.displayName = 'AccountActions';

const AccountActions = React.memo(AccountActionsComponent);

export { AccountActions };