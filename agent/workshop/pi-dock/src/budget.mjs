function renderBudget(value) {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

function invalidBudget(value) {
  throw new Error(`invalid budget: ${renderBudget(value)}`);
}

export function parseBudget(value, { manifest = false } = {}) {
  if (value === 'off') {
    return 'off';
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { turns, minutes } = value;
    if (Number.isSafeInteger(turns) && turns > 0 && Number.isFinite(minutes) && minutes > 0) {
      return { turns, minutes };
    }
    invalidBudget(value);
  }
  if (manifest || typeof value !== 'string' && value !== undefined) {
    invalidBudget(value);
  }

  const source = value ?? '20,30';
  const parts = source.split(',');
  if (parts.length > 2 || parts.some((part) => part.length === 0)) {
    invalidBudget(source);
  }

  const [turnText, minuteText = '30'] = parts;
  if (!/^\d+$/.test(turnText) || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(minuteText)) {
    invalidBudget(source);
  }

  const turns = Number(turnText);
  const minutes = Number(minuteText);
  if (!Number.isSafeInteger(turns) || turns <= 0 || !Number.isFinite(minutes) || minutes <= 0) {
    invalidBudget(source);
  }

  return { turns, minutes };
}

export function formatBudget(budget) {
  return budget === 'off' ? 'off' : `${budget.turns},${budget.minutes}`;
}
