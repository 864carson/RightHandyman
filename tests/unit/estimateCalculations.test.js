const {
  round2,
  calculateLineItem,
  calculateDeposit,
  calculateEstimateTotals,
  projectMarkupChange
} = require('../../src/services/estimateCalculations');

describe('round2', () => {
  test('rounds to 2 decimal places', () => {
    expect(round2(1.005)).toBeCloseTo(1.01, 2);
    expect(round2(19.999)).toBe(20);
    expect(round2(10)).toBe(10);
  });

  test('never returns -0', () => {
    expect(Object.is(round2(-0.001), -0)).toBe(false);
    expect(round2(-0.001)).toBe(0);
  });
});

describe('calculateLineItem', () => {
  test('percent markup: matches the spec worked example ($100 cost, 30% markup -> $130, ~23% margin)', () => {
    const result = calculateLineItem({ quantity: 1, unitCost: 100, markupType: 'percent', markupValue: 30 });
    expect(result.cost).toBe(100);
    expect(result.markupAmount).toBe(30);
    expect(result.price).toBe(130);
    expect(result.marginPercent).toBeCloseTo(23.08, 1);
  });

  test('cost is quantity x unitCost', () => {
    const result = calculateLineItem({ quantity: 5, unitCost: 28, markupType: 'percent', markupValue: 30 });
    expect(result.cost).toBe(140);
    expect(result.markupAmount).toBe(42);
    expect(result.price).toBe(182);
  });

  test('fixed markup applies once per line, not per unit', () => {
    const result = calculateLineItem({ quantity: 4, unitCost: 0, markupType: 'fixed', markupValue: 45 });
    expect(result.cost).toBe(0);
    expect(result.markupAmount).toBe(45);
    expect(result.price).toBe(45);
  });

  test('defaults markupType to percent when omitted', () => {
    const result = calculateLineItem({ quantity: 1, unitCost: 100, markupValue: 10 });
    expect(result.markupAmount).toBe(10);
  });

  test('missing/garbage fields default to zero rather than throwing or producing NaN', () => {
    expect(calculateLineItem({})).toEqual({ cost: 0, markupAmount: 0, price: 0, marginPercent: 0 });
    expect(calculateLineItem({ quantity: 'lots', unitCost: 'a lot' })).toEqual({
      cost: 0,
      markupAmount: 0,
      price: 0,
      marginPercent: 0
    });
  });

  test('zero price gives zero margin instead of dividing by zero', () => {
    const result = calculateLineItem({ quantity: 0, unitCost: 0, markupType: 'percent', markupValue: 0 });
    expect(result.marginPercent).toBe(0);
  });
});

describe('calculateDeposit', () => {
  test('percent deposit', () => {
    expect(calculateDeposit({ depositType: 'percent', depositValue: 50 }, 200)).toBe(100);
  });

  test('fixed deposit', () => {
    expect(calculateDeposit({ depositType: 'fixed', depositValue: 75 }, 200)).toBe(75);
  });

  test('fixed deposit is capped at the total price (never a negative balance due)', () => {
    expect(calculateDeposit({ depositType: 'fixed', depositValue: 99999 }, 200)).toBe(200);
  });

  test('no depositType means no deposit', () => {
    expect(calculateDeposit({}, 200)).toBe(0);
    expect(calculateDeposit({ depositType: null }, 200)).toBe(0);
  });
});

describe('calculateEstimateTotals', () => {
  const estimate = {
    taxRate: 7,
    depositType: 'percent',
    depositValue: 50,
    lineItems: [
      { category: 'materials', quantity: 10, unitCost: 8, markupType: 'percent', markupValue: 30 }, // cost 80, markup 24, price 104
      { category: 'labor', quantity: 4, unitCost: 25, markupType: 'percent', markupValue: 50 }, // cost 100, markup 50, price 150
      { category: 'travel', quantity: 1, unitCost: 0, markupType: 'fixed', markupValue: 40 } // cost 0, markup 40, price 40
    ]
  };

  test('rolls up cost, markup, and price across all line items', () => {
    const totals = calculateEstimateTotals(estimate);
    expect(totals.totalCost).toBe(180);
    expect(totals.totalMarkup).toBe(114);
    expect(totals.subtotalPrice).toBe(294);
  });

  test('applies tax on top of the price subtotal', () => {
    const totals = calculateEstimateTotals(estimate);
    expect(totals.taxAmount).toBe(round2(294 * 0.07));
    expect(totals.totalPrice).toBe(round2(294 + totals.taxAmount));
  });

  test('deposit and balance always sum back to the total price', () => {
    const totals = calculateEstimateTotals(estimate);
    expect(round2(totals.deposit + totals.balanceDue)).toBe(totals.totalPrice);
  });

  test('rolls line items up by category, price-only sums', () => {
    const totals = calculateEstimateTotals(estimate);
    expect(totals.byCategory.materials).toEqual({ cost: 80, markupAmount: 24, price: 104 });
    expect(totals.byCategory.labor).toEqual({ cost: 100, markupAmount: 50, price: 150 });
    expect(totals.byCategory.travel).toEqual({ cost: 0, markupAmount: 40, price: 40 });
  });

  test('an estimate with no line items totals to zero without throwing', () => {
    const totals = calculateEstimateTotals({ lineItems: [] });
    expect(totals.totalPrice).toBe(0);
    expect(totals.deposit).toBe(0);
    expect(totals.marginPercent).toBe(0);
  });

  test('lineItems defaults to an empty array when omitted entirely', () => {
    expect(() => calculateEstimateTotals({})).not.toThrow();
  });

  test('does not mutate the estimate or line items passed in', () => {
    const original = JSON.parse(JSON.stringify(estimate));
    calculateEstimateTotals(estimate);
    expect(estimate).toEqual(original);
  });
});

describe('projectMarkupChange', () => {
  test('applies a uniform markup-percent delta to percent-type lines only', () => {
    const estimate = {
      lineItems: [
        { quantity: 1, unitCost: 100, markupType: 'percent', markupValue: 30 },
        { quantity: 1, unitCost: 0, markupType: 'fixed', markupValue: 40 } // untouched -- not a %
      ]
    };
    const projected = projectMarkupChange(estimate, -10);
    expect(projected.lineItems[0].markupAmount).toBe(20); // 100 * 20%
    expect(projected.lineItems[1].markupAmount).toBe(40); // fixed, unchanged
  });

  test('never drops a markup percent below zero', () => {
    const estimate = { lineItems: [{ quantity: 1, unitCost: 100, markupType: 'percent', markupValue: 5 }] };
    const projected = projectMarkupChange(estimate, -50);
    expect(projected.lineItems[0].markupAmount).toBe(0);
  });
});
