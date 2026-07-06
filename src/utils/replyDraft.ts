// Convert a plain-text AI reply draft into the simple HTML the composer seeds
// its rich editor with: escape markup, blank lines become paragraphs, single
// newlines become <br>.
export function draftToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return escaped
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter((para) => para.length > 0)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('')
}
