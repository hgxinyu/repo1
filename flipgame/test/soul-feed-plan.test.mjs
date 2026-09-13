import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../SoulAscensionCalculator.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('      function calcBestFeedPlan('), html.indexOf('      function update()', html.indexOf('      function calcBestFeedPlan(')));
const expByTier = { 'B-': 50, B: 140, 'B+': 340, 'A-': 3050, A: 5750 };
function calculate(target, prices) {
  const context = { MAX_FEED_PER_TIER: 10, t: (key) => key, formatRounded: String,
    getPriceByTier: (key) => prices[key] ?? null };
  for (const key of ['totalCostDesc', 'bestComboValue', 'bestCostValue', 'bestExpValue', 'ascCostValue', 'totalCostValue', 'bestEffDesc']) context[key] = {};
  vm.createContext(context);
  const result = vm.runInContext(`${source}\ncalcBestFeedPlan(${target})`, context);
  const counts = {};
  for (const match of (context.bestComboValue.textContent || '').matchAll(/([A-Z]+[+-]?)×(\d+)/g)) counts[match[1]] = Number(match[2]);
  if (result.ok && target > 0) {
    assert.equal(Object.entries(counts).reduce((sum, [key, count]) => sum + prices[key] * count, 0), result.bestCost);
    assert.equal(Object.entries(counts).reduce((sum, [key, count]) => sum + expByTier[key] * count, 0), result.bestExp);
    assert.ok(result.bestExp >= target);
    assert.ok(['B-', 'B', 'B+'].reduce((sum, key) => sum + (counts[key] || 0), 0) <= 2);
    for (const [key, count] of Object.entries(counts)) {
      assert.ok(count <= 10);
      if (key.startsWith('B')) assert.ok(result.bestExp - expByTier[key] < target);
    }
  }
  return { ...result, counts };
}

test('B tiers only fill gaps with one or two copies total', () => {
  const prices = { 'B-': 1, B: 2, 'B+': 3, 'A-': 100 };
  assert.deepEqual(calculate(3100, prices).counts, { 'A-': 1, 'B-': 1 });
  assert.deepEqual(calculate(3240, prices).counts, { 'A-': 1, 'B-': 1, B: 1 });
  assert.deepEqual(calculate(3050, prices).counts, { 'A-': 1 });
  assert.equal(calculate(681, { 'B-': 1, B: 2, 'B+': 3 }).ok, false);
  assert.deepEqual(calculate(680, prices).counts, { 'B+': 2 });
});

test('bounded plans match exhaustive search even with unusually cheap B prices', () => {
  const prices = { 'B-': 1, B: 2, 'B+': 3, 'A-': 40, A: 61 };
  for (const target of [1, 100, 500, 700, 3000, 3390, 4000, 6100, 12000, 30000, 88000, 89000]) {
    let best = null;
    for (let a = 0; a <= 10; a++) for (let b = 0; b <= 10; b++)
      for (let c = 0; c <= 2; c++) for (let d = 0; d <= 2 - c; d++) for (let e = 0; e <= 2 - c - d; e++) {
        const exp = a * 3050 + b * 5750 + c * 50 + d * 140 + e * 340;
        if (exp < target || (c && exp - 50 >= target) || (d && exp - 140 >= target) || (e && exp - 340 >= target)) continue;
        const candidate = [a * 40 + b * 61 + c + d * 2 + e * 3, exp, a + b + c + d + e];
        if (!best || candidate[0] < best[0] || (candidate[0] === best[0] && (candidate[1] < best[1] || (candidate[1] === best[1] && candidate[2] < best[2])))) best = candidate;
      }
    const result = calculate(target, prices);
    assert.equal(result.ok, Boolean(best));
    if (best) assert.deepEqual([result.bestCost, result.bestExp, Object.values(result.counts).reduce((a, b) => a + b, 0)], best);
  }
});

test('zero target and unavailable prices', () => {
  assert.equal(calculate(0, {}).bestCost, 0);
  assert.equal(calculate(100, {}).ok, false);
});
