// Preparation rules for one chicken line item.
//
//   A. Service  - required, exactly one of
//        LIVE            the customer takes it alive. Nothing else applies and there is no fee.
//        POUR            "Pour"           (burn chicken)  - left whole, no cutting
//        NOT_POUR        "Dress"          (dress chicken) - left whole, no cutting
//        POUR_SLICE      "Po-ur & Slice"  (burn chicken, then sliced: a slice size is required)
//        NOT_POUR_SLICE  "Dress & Slice"  (dress chicken, then sliced: a slice size is required)
//        POUR_DUKOT      "Pour & Dukot"   (burn chicken, inside removed, NOT sliced)
//        NOT_POUR_DUKOT  "Dress & Dukot"  (dress chicken, inside removed, NOT sliced)
//   B. With Blood (saved as "dara") - optional on/off (not for Live)
//   C. Cutting  - only the two Slice services ask for a slice size (small, medium or large pieces).
//                 Pour and Dress are left whole, the two Dukot services are not sliced, and Live has no cutting.
//                 Choosing a slice size while any other service is selected switches to that service's Slice twin
//                 (Pour -> Po-ur & Slice), and choosing a whole or Dukot service clears the slice size.
//                 There is no standalone Dukot choice.
//
// The way it is SAVED is the same as before: feather = LIVE | POUR | NOT_POUR, cut = NONE | SLICE | DUKOT, plus the slice size.
// "Po-ur & Slice" is feather POUR with cut SLICE (that is exactly what older orders hold), "Pour & Dukot" is POUR with cut DUKOT and a
// plain "Pour" is POUR with cut NONE. serviceOf() turns that pair back into the service the cashier picked.
//
// The browser uses applyPrepChange() so the screen can never show a conflicting state.
// The server uses validatePrep() and REJECTS conflicting input; it never "fixes" it silently.
// The database repeats the same rules as CHECK constraints.

import { FEATHER, CUT, SLICE_SIZES, SERVICES, SERVICE_LABELS, BUILTIN_SERVICES } from './constants.js';

export function emptyPrep() {
  return { feather: null, dara: false, cut: 'NONE', sliceSize: null };
}

/** The service (one of SERVICES) for a saved preparation, or null while none is chosen. */
export function serviceOf(prep) {
  if (prep.service) return prep.service;   // Revision 19: the service the line was saved with (a built-in or one the admin added)
  if (prep.feather === 'LIVE') return 'LIVE';
  if (prep.feather !== 'POUR' && prep.feather !== 'NOT_POUR') return null;
  if (prep.cut === 'DUKOT') return `${prep.feather}_DUKOT`;
  if (prep.cut === 'SLICE') return `${prep.feather}_SLICE`;
  return prep.feather;
}

/** "Pour & Dukot", "Po-ur & Slice", "Dress", "Live" ... or '' while none is chosen. */
export const serviceLabel = (prep) => SERVICE_LABELS[serviceOf(prep)] ?? '';

/** Does this service ask for a slice size? Only the two Slice services do. */
export const needsSliceSize = (service, list) => (Array.isArray(list) ? list : BUILTIN_SERVICES).find((d) => d.code === service)?.cut === 'SLICE';

/**
 * Apply one change to a preparation state and return the new state.
 * change is one of:
 *   { service }  one of SERVICES
 *   { feather }  LIVE | POUR | NOT_POUR (changes the burn/dress/live part only and keeps the cutting choice)
 *   { dara }     true | false  (With Blood)
 *   { cut }      SMALL | MEDIUM | LARGE  (a slice size)
 */
export function applyPrepChange(prep, change, list) {
  const services = Array.isArray(list) ? list : BUILTIN_SERVICES;
  const next = { ...prep };
  const def = 'service' in change ? services.find((d) => d.code === change.service) : null;
  if (def) {
    // Revision 19: any service in the list (the seven built-ins and the ones the admin added) maps onto feather + cut. Only a service the admin
    // added is named in the preparation; a built-in one is worked out from feather + cut, so a preparation looks exactly as it always did.
    if (SERVICES.includes(def.code)) delete next.service; else next.service = def.code;
    next.feather = def.kind;
    if (def.kind !== 'LIVE') {
      next.cut = def.cut;
      if (def.cut === 'SLICE') { if (!SLICE_SIZES.includes(next.sliceSize)) next.sliceSize = null; }   // keep a size that is already chosen, otherwise wait for one
      else next.sliceSize = null;
    }
  }
  if ('feather' in change) { next.feather = change.feather; delete next.service; }
  if (next.feather === 'LIVE') {
    delete next.service;
    // A live chicken gets nothing else, so everything is cleared.
    next.dara = false;
    next.cut = 'NONE';
    next.sliceSize = null;
    return next;
  }
  if ('dara' in change) next.dara = Boolean(change.dara);
  if ('cut' in change && SLICE_SIZES.includes(change.cut)) {
    // Choosing a size on a service that is not a Slice service switches to its Slice twin (Pour -> Po-ur & Slice).
    const current = services.find((d) => d.code === next.service);
    if (!(current && current.cut === 'SLICE')) delete next.service;
    next.cut = 'SLICE'; next.sliceSize = change.cut;
  }
  return next;
}

/** Returns a list of plain-language problems. An empty list means the combination is valid. */
export function validatePrep(prep) {
  const errors = [];
  if (!FEATHER.includes(prep.feather)) errors.push('Choose a service.');
  if (typeof prep.dara !== 'boolean') errors.push('With Blood must be on or off.');

  if (prep.feather === 'LIVE') {
    if (prep.dara === true) errors.push('A live chicken cannot have With Blood.');
    if (prep.cut !== 'NONE' || (prep.sliceSize ?? null) !== null) errors.push('A live chicken has no cutting.');
  } else if (FEATHER.includes(prep.feather)) {
    if (!CUT.includes(prep.cut)) {
      errors.push('Choose a cutting option: whole, sliced or Dukot.');
    } else if (prep.cut === 'SLICE') {
      if (!SLICE_SIZES.includes(prep.sliceSize)) errors.push('Choose a slice size: small, medium or large pieces.');
    } else if (prep.cut === 'DUKOT') {
      if ((prep.sliceSize ?? null) !== null) errors.push('A Dukot service is not sliced, so it cannot have a slice size.');
    } else if ((prep.sliceSize ?? null) !== null) {
      errors.push('A chicken that is not sliced cannot have a slice size.');
    }
  }
  return errors;
}
