"""Portfolio notional exposure calculations."""


def calculate_notional(quantity: float, delta: float, current_price: float) -> float:
    """
    Calculate notional exposure: delta x quantity x price.

    Args:
        quantity: Number of shares or contracts
        delta: Delta (1.0 for shares, 0-1 for options)
        current_price: Current price in USD

    Returns:
        Notional exposure in USD
    """
    return delta * quantity * current_price


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
