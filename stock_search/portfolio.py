"""Portfolio notional exposure calculations."""


def calculate_notional(quantity: float, delta: float, current_price: float) -> float:
    """
    Calculate notional exposure from shares plus option-equivalent shares.

    Args:
        quantity: Number of underlying shares held
        delta: Net option delta in contract units; each 1.0 adds 100 share-equivalents
        current_price: Current price in USD

    Returns:
        Notional exposure in USD
    """
    effective_shares = quantity + (delta * 100.0)
    return effective_shares * current_price


def calculate_position_weight(notional: float, total_equity: float) -> float:
    """
    Calculate position weight as % of equity.

    Args:
        notional: Notional exposure
        total_equity: Total equity

    Returns:
        Weight as percentage
    """
    if total_equity <= 0:
        return 0.0
    return (notional / total_equity) * 100
