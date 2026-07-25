/** Owns dashboard color scale standards exposed by the utility API. */

export function buildColorStandardsPayload(): {
  standards: Record<string, { min: number; max: number }>;
} {
  return {
    standards: {
      market_cap: { min: 10e9, max: 4e12 },
      pe: { min: 12.0, max: 75.0 },
      pe_forward: { min: 12.0, max: 60.0 },
      peg: { min: 0.5, max: 3.0 },
      revenue: { min: 5e9, max: 700e9 },
      revenue_growth: { min: 0.0, max: 30.0 },
      eps_growth: { min: 0.0, max: 30.0 },
      gross_margin: { min: 10.0, max: 70.0 },
      operating_margin: { min: 0.0, max: 40.0 },
      roe: { min: 0.0, max: 30.0 },
      roic: { min: 0.0, max: 30.0 },
      debt_to_equity: { min: 0.0, max: 3.0 },
      shareholder_yield: { min: -5.0, max: 8.0 },
      median_upside: { min: 0.0, max: 50.0 },
      rsi: { min: 20.0, max: 80.0 },
      overall_score: { min: 2.0, max: 8.0 },
      quality_score: { min: 2.0, max: 8.0 },
      valuation_score: { min: 2.0, max: 8.0 },
      moat_score: { min: 2.0, max: 8.0 },
      upside_score: { min: 2.0, max: 8.0 },
      market_cap_score: { min: 2.0, max: 8.0 },
    },
  };
}
