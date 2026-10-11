// Preparation rules for one chicken line item.
//
//   A. Service  - required, exactly one of
//        LIVE      the customer takes it alive. Nothing else applies and there is no fee.
//        POUR      "Po-ur & Slice"   (burn chicken)  - always sliced
//        NOT_POUR  "Dressed & Slice" (dress chicken) - always sliced
//   B. Dara     - optional on/off (not for Live)
//   C. Cutting  - for Po-ur and Dressed it is required: a slice size (small, medium or large pieces) or Dukot.
//                 Live has no cutting.
//
// The browser uses applyPrepChange() so the screen can never show a conflicting state.
// The server uses validatePrep() and REJECTS conflicting input; it never "fixes" it silently.
// The database repeats the same rules as CHECK constraints.

import { FEATHER, SLICE_SIZES } from './constants.js';

export function emptyPrep() {
  return { feather: null, dara: false, cut: 'NONE', sliceSize: null };
}

/**
 * Apply one change to a preparation state and return the new state.
 * change is one of: { feather } | { dara } | { cut } where cut is SMALL, MEDIUM, LARGE or DUKOT.
 */
export function applyPrepChange(prep, change) {
  const next = { ...prep };
  if ('feather' in change) {
    next.feather = change.feather;
    if (next.feather === 'LIVE') {
      // A live chicken gets nothing else, so everything is cleared.
      next.dara = false;
      next.cut = 'NONE';
      next.sliceSize = null;
    }
  }
  if (next.feather === 'LIVE') return next; // the other groups are off while Live is chosen
  if ('dara' in change) next.dara = Boolean(change.dara);
  if ('cut' in change) {
    if (change.cut === 'DUKOT') { next.cut = 'DUKOT'; next.sliceSize = null; }
    else if (SLICE_SIZES.includes(change.cut)) { next.cut = 'SLICE'; next.sliceSize = change.cut; }
  }
  return next;
}

/** Returns a list of plain-language problems. An empty list means the combination is valid. */
export function validatePrep(prep) {
  const errors = [];
  if (!FEATHER.includes(prep.feather)) errors.push('Choose Live, Po-ur & Slice or Dressed & Slice.');
  if (typeof prep.dara !== 'boolean') errors.push('Dara must be on or off.');

  if (prep.feather === 'LIVE') {
    if (prep.dara === true) errors.push('A live chicken cannot have Dara.');
    if (prep.cut !== 'NONE' || (prep.sliceSize ?? null) !== null) errors.push('A live chicken has no cutting.');
  } else if (FEATHER.includes(prep.feather)) {
    if (prep.cut === 'SLICE') {
      if (!SLICE_SIZES.includes(prep.sliceSize)) errors.push('Choose a slice size: small, medium or large pieces.');
    } else if (prep.cut === 'DUKOT') {
      if ((prep.sliceSize ?? null) !== null) errors.push('Dukot cannot have a slice size.');
    } else {
      errors.push('Choose a slice size or Dukot.');
    }
  }
  return errors;
}
