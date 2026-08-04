'use strict';

const { gatherIndicators, directionalScore, WINDOWS } = require('./prediction');
const { SignalAccumulatorManager } = require('./signalAccumulator');

const LOOKBACK_MIN = 210;

// Same half-lives as the live engine, so a backtest run reflects the exact
// same accumulating-signal methodology that's actually trading live —
// not a separate, disconnected snapshot-only simulation.
const HALF_LIFE_MS = { w5: 2 * 60 * 1000, w10: 4 * 60 * 1000, w15: 7 * 60 * 1000 };

function backtestSymbol(candles, { stepMinutes = 1 } = {}) {
    const perWindow = {};

    for (const w of WINDOWS) {
        perWindow[w.key] = {
            label: w.label,
            minutes: w.minutes,
            correct: 0,
            total: 0,
        };
    }

    // A fresh manager per run — historical replays never share accumulated
    // state with live trading or with any other backtest run.
    const accumulatorManager = new SignalAccumulatorManager(HALF_LIFE_MS);

    const maxHorizon = Math.max(...WINDOWS.map((w) => w.minutes));
    const lastUsableIndex = candles.length - maxHorizon - 1;

    for (let i = LOOKBACK_MIN; i <= lastUsableIndex; i += stepMinutes) {
        const historySlice = candles.slice(0, i + 1);

        const series = {
            candles: historySlice,
            closes: () => historySlice.map((c) => c.close),
            volumes: () => historySlice.map((c) => c.volume),
            latestClose: () => historySlice[historySlice.length - 1].close,
            ready: (n) => historySlice.length >= n,
        };

        const ind = gatherIndicators(series, null);
        if (!ind) continue;

        const currentPrice = candles[i].close;
        // Use this historical candle's own timestamp as "now" — decay is
        // driven by real elapsed time between candles (stepMinutes * 60s),
        // exactly like the live engine's refresh cadence, just compressed
        // or stretched to however many minutes each backtest step covers.
        const historicalNow = candles[i].time;

        for (const w of WINDOWS) {
            const { weighted, maxWeightSum } = directionalScore(ind, w.key);
            const accumulator = accumulatorManager.get('backtest', w.key);
            const { netDominance } = accumulator.update(Object.values(weighted), historicalNow);
            const predictedUp = netDominance > 0;

            const futureIndex = i + w.minutes;
            if (futureIndex >= candles.length) continue;

            const actualUp = candles[futureIndex].close >= currentPrice;

            perWindow[w.key].total += 1;

            if (predictedUp === actualUp) {
                perWindow[w.key].correct += 1;
            }
        }
    }

    const summary = {};

    for (const key of Object.keys(perWindow)) {
        const {
            label,
            minutes,
            correct,
            total,
        } = perWindow[key];

        const accuracyPct = total
            ? +((correct / total) * 100).toFixed(1)
            : null;

        const illustrativeReturnPct =
            accuracyPct != null
                ? +((2 * accuracyPct - 100).toFixed(1))
                : null;

        summary[key] = {
            window: label,
            minutes,
            sampleSize: total,
            correctCount: correct,
            accuracyPct,
            illustrativeReturnPct,
        };
    }

    return summary;
}

module.exports = {
    backtestSymbol,
    LOOKBACK_MIN,
};
