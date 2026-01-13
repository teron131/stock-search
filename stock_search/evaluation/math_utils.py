import math


def clamp_score(value: float) -> float:
    """Clamp score to valid range [0, 10] and round to 2 decimals."""
    if value < 0.0:
        return 0.0
    if value > 10.0:
        return 10.0
    return round(value, 2)


def z_score_map(
    value: float,
    in_min: float,
    in_max: float,
    in_median: float,
    out_min: float = 0.0,
    out_max: float = 10.0,
) -> float:
    """Map a value using a Normal CDF (S-curve) based on piecewise Z-scores."""
    if value <= in_min:
        return out_min
    if value >= in_max:
        return out_max

    # 1 sigma = 1/3 distance to median
    sigma = ((in_median - in_min) if value <= in_median else (in_max - in_median)) / 3.0
    z = (value - in_median) / sigma if sigma > 0 else 0

    phi = 0.5 * (1 + math.erf(z / math.sqrt(2)))
    return clamp_score(out_min + (out_max - out_min) * phi)
