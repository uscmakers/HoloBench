/** A top-down picture of a brick's studs, w × d. */
export function studIcon(w: number, d: number) {
  const dots = '<i></i>'.repeat(w * d);
  return `<span class="studs" style="grid-template-columns: repeat(${d}, 1fr); width: ${d * 9}px">${dots}</span>`;
}