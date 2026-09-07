// The area the display covers, defined once.
//
// It lives in core rather than in the server because the browser needs the same
// numbers to place aircraft on screen. Two copies of a bounding box is two
// chances for the map and the data to disagree about where things are.

export interface BoundingBox {
  lamin: number;
  lomin: number;
  lamax: number;
  lomax: number;
}

/**
 * The Stockholm terminal area: Arlanda, Bromma and Skavsta, with enough of the
 * approaches either side to see aircraft arrive rather than appear.
 *
 * The longitude span is deliberately wide. A degree of longitude at 59.65°N is
 * about half a degree of latitude on the ground, so 4.6° of longitude against
 * 1.3° of latitude is roughly 16:9 once projected — the box fills a screen
 * instead of sitting in a letterboxed column. It is 5.98 sq°, comfortably
 * inside the 25 sq° band, so it still costs a single credit per call.
 */
export const STOCKHOLM: BoundingBox = { lamin: 59.0, lomin: 16.2, lamax: 60.3, lomax: 20.8 };

/** Credits charged per `/states/all` call, by bounding-box area in square degrees. */
export function creditCost(box: BoundingBox): number {
  const area = (box.lamax - box.lamin) * (box.lomax - box.lomin);
  if (area <= 25) return 1;
  if (area <= 100) return 2;
  if (area <= 400) return 3;
  return 4;
}
