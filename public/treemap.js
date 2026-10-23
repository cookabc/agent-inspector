/**
 * The disk treemap: laying categories out by area.
 *
 * The overview used to be one number — "15.7 MB" — with nothing to compare
 * it against. A disk audit is a question about proportion: which thing eats
 * the space, and how much of it. A treemap answers that by area, which is
 * the only encoding that survives a dozen categories at once.
 *
 * The layout is a squarified treemap (Bruls, Huizing and van Wijk): the
 * rectangles come out as close to square as the proportions allow, so a
 * category with 5% of the disk is a small square rather than a thin sliver
 * nobody can click.
 *
 * The module is plain JavaScript with no DOM so it can be unit tested with
 * `node --test`, the same way public/logic.js already is.
 */

/**
 * Squarified treemap.
 *
 * The remaining region is filled one strip at a time. Each strip is placed
 * along the long side of what is left, so the strip is thin in one
 * direction and the items inside it are distributed along the other. A strip
 * is only made longer while doing so keeps the rectangles square-ish —
 * adding a very different item makes the row worse, and the row is placed
 * as it stands.
 *
 * `minShare` gives every item a floor on the area it may occupy. A disk
 * audit routinely has one category holding 90% and a dozen holding almost
 * nothing; without a floor those dozen collapse to slivers a few pixels
 * wide, which is the map saying "there is nothing else here" when in fact
 * it is saying "there is nothing else worth drawing". The floor exaggerates
 * the small blocks on purpose — the true size is always printed on them.
 *
 * @param items    [{ id, value }] — value must be > 0 to be laid out.
 * @param rect     { x, y, w, h } — the area to fill.
 * @param minShare Smallest share of the area any one item may take.
 * @returns        [{ id, value, x, y, w, h }] in the same order as the input.
 */
export function squarify(items, rect, minShare = 0) {
  if (!items.length || rect.w <= 0 || rect.h <= 0) return [];

  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return [];

  // Sort descending by value: the layout puts the big ones first. The index
  // tiebreak keeps the result deterministic for equal values.
  const sorted = items
    .map((item, index) => ({ ...item, index }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index);

  const area = rect.w * rect.h;

  // The floor works on the values, so the areas that come out of it still
  // add up to the region.
  const floor = minShare > 0 ? minShare * total : 0;
  const adjusted = sorted.map((item) => ({
    ...item,
    weight: Math.max(item.value, floor),
  }));
  const weightTotal = adjusted.reduce((sum, item) => sum + item.weight, 0);
  if (weightTotal <= 0) return [];

  const queue = adjusted.map((item) => ({
    ...item,
    area: (item.weight / weightTotal) * area,
  }));

  const out = [];
  let region = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };

  while (queue.length) {
    const row = [];
    let rowArea = 0;

    // Grow the row while adding the next item keeps it square-ish.
    while (queue.length) {
      const next = queue[0];
      const candidate = [...row, next];
      const candidateArea = rowArea + next.area;
      if (row.length && worstRatio(candidate, candidateArea, region) > worstRatio(row, rowArea, region)) {
        break;
      }
      row.push(next);
      rowArea = candidateArea;
      queue.shift();
    }

    region = placeRow(row, rowArea, region, out);
    if (region.w <= 0 || region.h <= 0) break;
  }

  // Back to the caller's order.
  const byId = new Map(out.map((item) => [item.id, item]));
  return items.map((item) => byId.get(item.id)).filter(Boolean);
}

/**
 * The worst aspect ratio in a row.
 *
 * A row is "square enough" when every rectangle in it has a similar width
 * and height. This returns the worst offender's ratio, so a row can be
 * grown only while it stays square-ish.
 */
function worstRatio(row, rowArea, region) {
  if (rowArea <= 0) return Infinity;

  // The strip the row will occupy is thin in one direction; every item in
  // it is then distributed along the other.
  const tall = region.w <= region.h;
  const thickness = tall ? rowArea / region.h : rowArea / region.w;

  let worst = 0;
  for (const item of row) {
    const length = item.area / thickness;
    if (length <= 0 || thickness <= 0) continue;
    const ratio = Math.max(length / thickness, thickness / length);
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

/**
 * Place one row into the region and return what is left of it.
 */
function placeRow(row, rowArea, region, out) {
  if (!row.length) return region;

  const tall = region.w <= region.h;
  // The strip is thin across the region's long side, and the items are
  // distributed along its short side.
  const thickness = tall ? rowArea / region.h : rowArea / region.w;

  let offset = 0;
  for (const item of row) {
    const length = item.area / thickness;
    if (tall) {
      // A tall region: the strip runs down the left, items stack vertically.
      out.push({
        id: item.id,
        value: item.value,
        x: region.x,
        y: region.y + offset,
        w: thickness,
        h: length,
      });
    } else {
      // A wide region: the strip runs across the top, items go side by side.
      out.push({
        id: item.id,
        value: item.value,
        x: region.x + offset,
        y: region.y,
        w: length,
        h: thickness,
      });
    }
    offset += length;
  }

  if (tall) {
    return { x: region.x + thickness, y: region.y, w: region.w - thickness, h: region.h };
  }
  return { x: region.x, y: region.y + thickness, w: region.w, h: region.h - thickness };
}

/**
 * The treemap for a tool's categories.
 *
 * Categories are grouped by what happens if you delete them — the verdict —
 * because that is the question the reader actually has. Each group gets its
 * own band, and inside a band the categories are laid out by size.
 *
 * @param categories [{ id, label, value, verdict, status }]
 * @param rect      { x, y, w, h }
 */
export function verdictTreemap(categories, rect) {
  const groups = new Map();
  for (const category of categories) {
    if (!(category.value > 0)) continue;
    const list = groups.get(category.verdict) ?? [];
    list.push(category);
    groups.set(category.verdict, list);
  }
  if (!groups.size) return [];

  // Bands are ordered by the verdict's own severity: what you can clear
  // first, what needs care, what you must not touch.
  const ORDER = ['junk', 'safe', 'review', 'never'];
  const bands = [...groups.entries()]
    .sort((a, b) => {
      const ai = ORDER.indexOf(a[0]);
      const bi = ORDER.indexOf(b[0]);
      return (ai < 0 ? ORDER.length : ai) - (bi < 0 ? ORDER.length : bi);
    })
    .map(([verdict, list]) => ({
      verdict,
      items: list,
      value: list.reduce((sum, c) => sum + c.value, 0),
    }));

  const total = bands.reduce((sum, band) => sum + band.value, 0);
  if (total <= 0) return [];

  // A gap between bands, so they read as separate regions.
  const GAP = 3;
  const gaps = GAP * (bands.length - 1);
  const usable = Math.max(1, rect.h - gaps);

  // Tiny categories remain selectable in the adjacent category list.
  // Map area always represents bytes, without a minimum visual weight.
  const out = [];
  let y = rect.y;
  for (const band of bands) {
    const share = band.value / total;
    const height = share * usable;

    const laid = squarify(
      band.items.map((c) => ({ id: c.id, value: c.value })),
      { x: rect.x, y, w: rect.w, h: height },
      0,
    );
    const byId = new Map(laid.map((item) => [item.id, item]));
    for (const category of band.items) {
      const box = byId.get(category.id);
      if (!box) continue;
      out.push({
        ...box,
        label: category.label,
        verdict: category.verdict,
        status: category.status,
      });
    }
    y += height + GAP;
  }
  return out;
}
