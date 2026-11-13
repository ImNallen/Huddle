export const COLUMN_WIDTH = 193
export const GAP = 8
const MIN_HEIGHT = 72
const MAX_HEIGHT = 280

export type Placement = { column: 0 | 1; top: number; height: number }

export function masonry(sizes: readonly { width: number; height: number }[]) {
  const bottoms: [number, number] = [0, 0]
  const placements = sizes.map(({ width, height }): Placement => {
    const tall = Math.round((COLUMN_WIDTH * height) / width)
    const column = bottoms[0] <= bottoms[1] ? 0 : 1
    const placement = {
      column,
      top: bottoms[column],
      height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, tall)),
    } as const
    bottoms[column] += placement.height + GAP
    return placement
  })
  return { placements, height: Math.max(0, ...bottoms.map((bottom) => bottom - GAP)) }
}

export type GridKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
export const isGridKey = (key: string): key is GridKey =>
  ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)

export function neighbor(
  placements: readonly Placement[],
  usable: readonly boolean[],
  from: number,
  key: GridKey,
): number | null {
  const here = placements[from]
  const tiles = placements.flatMap((placement, index) =>
    usable[index] ? [{ ...placement, index }] : [],
  )
  if (key === 'Home') return tiles[0]?.index ?? null
  if (key === 'End') return tiles.at(-1)?.index ?? null
  if (!here) return null
  const middle = (tile: Placement) => tile.top + tile.height / 2
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const below = key === 'ArrowDown'
    const column = tiles
      .filter(
        (tile) =>
          tile.column === here.column && (below ? tile.top > here.top : tile.top < here.top),
      )
      .sort((a, b) => (below ? a.top - b.top : b.top - a.top))
    return column[0]?.index ?? null
  }
  const column = key === 'ArrowLeft' ? 0 : 1
  if (here.column === column) return null
  const nearest = tiles
    .filter((tile) => tile.column === column)
    .sort(
      (a, b) =>
        Math.abs(middle(a) - middle(here)) - Math.abs(middle(b) - middle(here)) || a.top - b.top,
    )
  return nearest[0]?.index ?? null
}
