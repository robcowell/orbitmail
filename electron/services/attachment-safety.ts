// Classification for "is opening this attachment likely to run code?".
//
// `attachments:open` hands the file to the OS opener, and both the filename and
// its extension come from whoever sent the mail. On Linux a .desktop file is a
// launcher, .sh/.run are scripts, and a .pdf.exe reads as a PDF in the UI while
// ending in .exe on disk. Opening any of those deserves a deliberate second
// step rather than a single click.
//
// This is a prompt, not a block: the user may well have asked a colleague for a
// script. It exists so that "open" is never silently "execute".

const EXECUTABLE_EXTENSIONS = new Set([
  // Linux
  'desktop', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'run', 'bin', 'elf', 'out',
  'appimage', 'deb', 'rpm', 'flatpakref', 'snap',
  // Cross-platform interpreters
  'jar', 'py', 'pyc', 'pl', 'rb', 'php', 'lua', 'js', 'jse', 'mjs', 'cjs',
  // Windows — harmless to run here, but a strong signal the mail is hostile
  'exe', 'msi', 'com', 'bat', 'cmd', 'scr', 'pif', 'cpl', 'ps1', 'psm1',
  'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'reg', 'lnk',
  // macOS / mobile
  'app', 'command', 'dmg', 'pkg', 'apk'
])

/** The final extension, lowercased, without the dot. Empty if there is none. */
export function attachmentExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** True when opening the file could execute code rather than display it. */
export function isExecutableAttachment(filename: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(attachmentExtension(filename))
}

/**
 * Warning shown before opening. Names the real extension explicitly, because
 * the point of a `.pdf.exe` is that the eye stops reading at `.pdf`.
 */
export function executableAttachmentWarning(filename: string): {
  message: string
  detail: string
} {
  const ext = attachmentExtension(filename)
  return {
    message: `Open “${filename}”?`,
    detail:
      `This is a .${ext} file. Opening it may run a program rather than show a ` +
      `document, and attachments can arrive from anyone. Only continue if you ` +
      `were expecting this file from this sender.`
  }
}
