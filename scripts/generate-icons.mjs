import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(root, 'build/icon.svg')
const iconsDir = join(root, 'build/icons')
const sizes = [16, 32, 48, 64, 128, 256, 512]

mkdirSync(iconsDir, { recursive: true })

for (const size of sizes) {
  const out = join(iconsDir, `${size}x${size}.png`)
  const density = size <= 48 ? 512 : 384
  await sharp(svgPath, { density }).resize(size, size).png().toFile(out)
  console.log(`Wrote ${out}`)
}

await sharp(svgPath, { density: 384 }).resize(512, 512).png().toFile(join(root, 'build/icon.png'))
console.log(`Wrote ${join(root, 'build/icon.png')}`)

// ---------------------------------------------------------------------------
// Tray icons.
//
// The tray shows the unread count, and the number has to be *in the image*:
// Electron's Tray exposes no label on Linux (`setTitle` is macOS-only), and the
// panel only ever renders the icon. So pre-render one image per count — the main
// process just swaps which file it points at. Counts above nine collapse to
// "9+", because a two-digit number is unreadable at 22px.
// ---------------------------------------------------------------------------

const TRAY_SIZE = 64
const trayDir = join(iconsDir, 'tray')
mkdirSync(trayDir, { recursive: true })

const base = await sharp(svgPath, { density: 384 })
  .resize(TRAY_SIZE, TRAY_SIZE)
  .png()
  .toBuffer()

await sharp(base).toFile(join(trayDir, 'tray.png'))
console.log(`Wrote ${join(trayDir, 'tray.png')}`)

// A filled circle bottom-right, sized so it stays legible when the panel scales
// the icon down. Red keeps it readable on both light and dark panels.
function badgeSvg(label) {
  const r = 17
  const cx = TRAY_SIZE - r - 3
  const cy = TRAY_SIZE - r - 3
  const fontSize = label.length > 1 ? 18 : 23
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TRAY_SIZE}" height="${TRAY_SIZE}">
       <circle cx="${cx}" cy="${cy}" r="${r}" fill="#e5484d" stroke="#ffffff" stroke-width="4"/>
       <text x="${cx}" y="${cy}" fill="#ffffff" font-family="DejaVu Sans, sans-serif"
             font-size="${fontSize}" font-weight="bold" text-anchor="middle"
             dominant-baseline="central">${label}</text>
     </svg>`
  )
}

for (const label of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '9+']) {
  const name = label === '9+' ? 'tray-9plus.png' : `tray-${label}.png`
  const out = join(trayDir, name)
  await sharp(base)
    .composite([{ input: badgeSvg(label), top: 0, left: 0 }])
    .png()
    .toFile(out)
  console.log(`Wrote ${out}`)
}
