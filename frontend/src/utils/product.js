// Classify an execution into one of the three migration products.
// Message runs carry context.kind === 'message'; mail/content carry context.domain.
export const PRODUCTS = [
  { key: 'mail', label: 'Mail' },
  { key: 'content', label: 'Content' },
  { key: 'message', label: 'Message' },
];

export const PRODUCT_LABEL = { mail: 'Mail', content: 'Content', message: 'Message' };

export function productOf(exec) {
  const ctx = exec?.context || {};
  if (ctx.kind === 'message' || ctx.messageCombination) return 'message';
  if (ctx.domain === 'content') return 'content';
  if (ctx.domain === 'mail') return 'mail';
  const pt = String(ctx.productType || '').toLowerCase();
  if (pt.includes('message')) return 'message';
  if (pt.includes('content')) return 'content';
  return 'mail'; // legacy default
}

/** Count executions per product (+ all) for tab badges. */
export function productCounts(executions = []) {
  const counts = { all: executions.length, mail: 0, content: 0, message: 0 };
  for (const e of executions) counts[productOf(e)] += 1;
  return counts;
}
