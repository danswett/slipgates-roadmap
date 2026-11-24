import { readFileSync } from 'node:fs';
import { validatePeopleCounts } from './people-at-work.mjs';
import { validateFleetCounts } from './fleet-counts.mjs';
import { validateCost } from './cost.mjs';

function readCounts(path, validate, now) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return validate(value, now);
}
export const readPeopleCounts = (path, now = Date.now()) => readCounts(path, validatePeopleCounts, now);
export const readFleetCounts = (path) => readCounts(path, validateFleetCounts, Date.now());
export const readCostFile = (path) => readCounts(path, validateCost, Date.now());
