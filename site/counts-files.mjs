import { readFileSync } from 'node:fs';
import { validatePeopleCounts } from './people-at-work.mjs';
import { validateFleetCounts } from './fleet-counts.mjs';

// maxAge is the validator's own default (strict) unless the caller asks for the last good file, whatever its age (2026-11-23).
function readCounts(path, validate, now, maxAge) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return validate(value, now, maxAge);
}
export const readPeopleCounts = (path, now = Date.now(), maxAge) => readCounts(path, validatePeopleCounts, now, maxAge);
export const readFleetCounts = (path, maxAge) => readCounts(path, validateFleetCounts, Date.now(), maxAge);
