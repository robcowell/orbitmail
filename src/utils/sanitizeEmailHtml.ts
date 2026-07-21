import DOMPurify from 'dompurify'

// Message bodies are attacker-controlled HTML rendered inside the app's own
// document, which carries the full-privilege preload. DOMPurify's defaults are
// tuned for "safe HTML in a web page", not for that threat model, so we forbid
// three extra classes of markup on top of scripting:
//
//  - Navigation sinks. `form`/`button`/`input` are allowed by default, as are
//    the `action`/`method` attributes, and a submit navigates the *current*
//    window — an attacker page would then inherit `window.orbitMail`. (The
//    main process also blocks navigation, and the CSP sets `form-action 'none'`;
//    this is the first of those three layers.)
//  - Embedding sinks: `iframe`/`object`/`embed`/`frame`.
//  - Document-level tags that can retarget or restyle the app shell: `base`,
//    `meta`, `link`, `title`.
const FORBID_TAGS = [
  'script',
  'style',
  'form',
  'button',
  'input',
  'select',
  'option',
  'optgroup',
  'textarea',
  'label',
  'fieldset',
  'legend',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'base',
  'meta',
  'link',
  'title'
]

const FORBID_ATTR = ['action', 'formaction', 'method', 'target', 'ping', 'srcdoc']

// DOMPurify never inspects `style` attribute *contents*, so an email can escape
// the reader pane with `position: fixed; z-index: …` and repaint the whole
// window (a convincing in-app phishing surface). Strip the properties that
// break out of normal flow; everything else is left alone so mail still renders
// the way the sender intended.
const ESCAPING_STYLE = /(?:^|;)\s*(?:position|z-index|inset|top|right|bottom|left)\s*:[^;]*/gi
const ESCAPING_POSITION_VALUE = /^\s*(?:fixed|sticky|absolute)\s*$/i

let hookInstalled = false

function installHook(): void {
  if (hookInstalled) return
  hookInstalled = true

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return

    const style = node.getAttribute('style')
    if (style) {
      // Only rewrite when the declaration actually breaks out of flow —
      // `position: relative` and plain offsets are harmless and common.
      const positioned = /(?:^|;)\s*position\s*:([^;]*)/i.exec(style)
      if (positioned && ESCAPING_POSITION_VALUE.test(positioned[1])) {
        const cleaned = style.replace(ESCAPING_STYLE, '').replace(/^\s*;+/, '').trim()
        if (cleaned) node.setAttribute('style', cleaned)
        else node.removeAttribute('style')
      }
    }

    // Anchors are handed to shell.openExternal by the click handler, and mail
    // legitimately opens links in a new window, so keep href but normalize the
    // target away (it is forbidden above; this covers the ADD_ATTR path).
    if (node.hasAttribute('target')) node.removeAttribute('target')
  })
}

/**
 * Sanitize an email body for rendering inside the app document.
 *
 * Returns null for empty input so callers can fall back to the plain-text body.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string | null {
  if (!html) return null
  installHook()
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['href'],
    FORBID_TAGS,
    FORBID_ATTR
  })
}
