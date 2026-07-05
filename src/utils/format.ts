// Human-readable file size, e.g. 240 KB, 1.2 MB.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exp)
  const rounded = value >= 100 || exp === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[exp]}`
}
