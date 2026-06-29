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
