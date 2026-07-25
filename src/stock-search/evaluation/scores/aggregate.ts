/** Blend score lanes and apply portfolio-role profiles. */

import {
  CoreEngineWeights,
  CycleNormalizationConfig,
  DEFAULT_SCORE,
  DiversifierWeights,
  OverallScoreConfig,
  OverallScoreWeights,
  SatelliteWeights,
  SCORE_SCALE,
  SpeculativeWeights,
  type StrategyBucket,
} from "../constants.js";
import { clampScore } from "../math-utils.js";
import { finiteScore, scoreOrNeutral } from "./shared.js";

const STRATEGY_BUCKETS: Record<string, StrategyBucket> = {
  core: {
    scoreKeys: ["moat_score", "quality_score", "valuation_score", "size_score"],
    weights: [
      CoreEngineWeights.MOAT,
      CoreEngineWeights.QUALITY,
      CoreEngineWeights.VALUATION,
      CoreEngineWeights.SIZE,
    ],
    invertFlags: [false, false, false, false],
  },
  satellite: {
    scoreKeys: ["moat_score", "quality_score", "valuation_score", "upside_score"],
    weights: [
      SatelliteWeights.MOAT,
      SatelliteWeights.QUALITY,
      SatelliteWeights.VALUATION,
      SatelliteWeights.UPSIDE,
    ],
    invertFlags: [false, false, false, false],
  },
  speculative: {
    scoreKeys: ["upside_score", "quality_score", "moat_score", "valuation_score"],
    weights: [
      SpeculativeWeights.UPSIDE,
      SpeculativeWeights.QUALITY,
      SpeculativeWeights.MOAT,
      SpeculativeWeights.VALUATION,
    ],
    invertFlags: [false, true, true, true],
  },
  diversifier: {
    scoreKeys: ["quality_score", "valuation_score", "size_score", "upside_score"],
    weights: [
      DiversifierWeights.QUALITY,
      DiversifierWeights.VALUATION,
      DiversifierWeights.SIZE,
      DiversifierWeights.UPSIDE,
    ],
    invertFlags: [false, false, false, true],
  },
};

/** Compute the public overall score with weak core fundamentals treated as bottlenecks. */
export function calculateOverallScore(
  scores: Record<string, number | null | undefined>,
  cycleRisk = 0,
): number | null {
  const coreScores = [
    finiteScore(scores.moat_score),
    finiteScore(scores.quality_score),
    finiteScore(scores.valuation_score),
    finiteScore(scores.upside_score),
  ];
  if (coreScores.every((score) => score == null)) {
    return null;
  }

  const weightedScore =
    scoreOrNeutral(scores.moat_score) * OverallScoreWeights.MOAT +
    scoreOrNeutral(scores.quality_score) * OverallScoreWeights.QUALITY +
    scoreOrNeutral(scores.valuation_score) * OverallScoreWeights.VALUATION +
    scoreOrNeutral(scores.upside_score) * OverallScoreWeights.UPSIDE;
  const weakestCoreScore = Math.min(
    scoreOrNeutral(scores.moat_score),
    scoreOrNeutral(scores.quality_score),
    scoreOrNeutral(scores.valuation_score),
  );
  const bottleneckPenalty =
    Math.max(0, DEFAULT_SCORE - weakestCoreScore) * OverallScoreConfig.BOTTLENECK_PENALTY;

  const overallScore = clampScore(weightedScore - bottleneckPenalty);
  if (cycleRisk >= CycleNormalizationConfig.SEVERE_RISK) {
    return Math.min(overallScore, CycleNormalizationConfig.SEVERE_RISK_OVERALL_CAP);
  }
  if (cycleRisk >= CycleNormalizationConfig.HIGH_RISK) {
    return Math.min(overallScore, CycleNormalizationConfig.HIGH_RISK_OVERALL_CAP);
  }
  return overallScore;
}

/** Apply strategy weights to core scores to find suitable portfolio buckets. */
export function calculateStrategyIndices(
  scores: Record<string, number | null | undefined>,
): Record<string, number | null> {
  const indices: Record<string, number | null> = {};

  for (const [name, bucket] of Object.entries(STRATEGY_BUCKETS)) {
    const bucketScores = bucket.scoreKeys.map((key) => scores[key] ?? null);
    if (bucketScores.some((score) => score == null)) {
      indices[name] = null;
      continue;
    }

    const adjustedScores = bucketScores.map((score, index) =>
      bucket.invertFlags[index] ? SCORE_SCALE - Number(score) : Number(score),
    );
    const weightedScore = adjustedScores.reduce(
      (sum, score, index) => sum + score * bucket.weights[index],
      0,
    );
    indices[name] = weightedScore;
  }
  return indices;
}
