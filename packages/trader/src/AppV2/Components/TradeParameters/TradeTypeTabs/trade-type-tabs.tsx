import React from 'react';
import { observer } from 'mobx-react-lite';

import { getTradeTypeTabsList } from 'AppV2/Utils/trade-params-utils';
import { useTraderStore } from 'Stores/useTraderStores';

import { TTradeParametersProps } from '../trade-parameters';

// [AI] Tab toggle hidden — dual buy buttons (Over+Under, Matches+Differs, Even+Odd, etc.)
// now handle direction selection, so this segmented control is redundant.
// We keep the side-effect of initializing trade_type_tab so the PurchaseButton
// proposals still work correctly.
const TradeTypeTabs = observer((_: TTradeParametersProps) => {
    const { contract_type, setTradeTypeTab } = useTraderStore();
    const tab_list = getTradeTypeTabsList(contract_type);

    React.useEffect(() => {
        // Initialize trade_type_tab to the first tab so downstream logic works,
        // but don't render anything visible.
        if (tab_list.length > 0) {
            setTradeTypeTab(tab_list[0].contract_type);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab_list.length, contract_type]);

    return null;
});

export default TradeTypeTabs;