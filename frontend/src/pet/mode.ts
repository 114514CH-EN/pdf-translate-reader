/**
 * The pet build is the same app with the reading assistant replaced by a pet.
 * `main.tsx` and `pet/main.tsx` both render the same `App`; the pet entry calls
 * `setPetMode(true)` before the first render, so every branch below is decided
 * once per page load and never changes afterwards.
 */

export const PET_SUMMON_EVENT = 'pdftr:pet-summon';

let petMode = false;

export function setPetMode(on: boolean): void {
  petMode = on;
}

export function isPetMode(): boolean {
  return petMode;
}

/** Wake the pet and open its bubble — used by the sidebar button and by 划词. */
export function summonPet(): void {
  window.dispatchEvent(new Event(PET_SUMMON_EVENT));
}
