const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatSize(bytes: number): string {
  if (bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`

  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${SIZE_UNITS[unit]}`
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

const fullFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  day: '2-digit',
  month: 'short'
})

export function formatDate(mtimeMs: number): string {
  const date = new Date(mtimeMs)
  const now = new Date()

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return timeFormatter.format(date)

  if (date.getFullYear() === now.getFullYear()) return dayFormatter.format(date)

  return fullFormatter.format(date)
}

const PERMISSION_SYMBOLS = [
  { mask: 0o400, symbol: 'r' },
  { mask: 0o200, symbol: 'w' },
  { mask: 0o100, symbol: 'x' },
  { mask: 0o040, symbol: 'r' },
  { mask: 0o020, symbol: 'w' },
  { mask: 0o010, symbol: 'x' },
  { mask: 0o004, symbol: 'r' },
  { mask: 0o002, symbol: 'w' },
  { mask: 0o001, symbol: 'x' }
] as const

export function formatMode(mode: number): string {
  let result = ''
  for (const { mask, symbol } of PERMISSION_SYMBOLS) {
    result += (mode & mask) === mask ? symbol : '-'
  }
  return result
}
