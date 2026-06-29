import type { FlagColor } from '../../shared/types'

export const FLAG_COLORS: Array<{ id: FlagColor; label: string; hex: string }> = [
  { id: 'red', label: 'Red', hex: '#ff3b30' },
  { id: 'orange', label: 'Orange', hex: '#ff9500' },
  { id: 'yellow', label: 'Yellow', hex: '#ffcc00' },
  { id: 'green', label: 'Green', hex: '#34c759' },
  { id: 'blue', label: 'Blue', hex: '#007aff' },
  { id: 'purple', label: 'Purple', hex: '#af52de' },
  { id: 'gray', label: 'Gray', hex: '#8e8e93' }
]

export function flagColorHex(color: FlagColor | null | undefined): string | undefined {
  if (!color) return undefined
  return FLAG_COLORS.find((entry) => entry.id === color)?.hex
}
