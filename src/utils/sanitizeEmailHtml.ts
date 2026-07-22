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

// A URL that would trigger a network fetch to a third party: absolute http(s) or
// protocol-relative. NOT data: (inline bytes) or cid: (inline attachment), which
// render without any request and are always kept.
function isRemoteUrl(url: string | null | undefined): boolean {
  return /^\s*(?:https?:)?\/\//i.test(url ?? '')
}

// Set synchronously right before DOMPurify.sanitize and read by the hook (the
// hook is registered once, globally, and sanitize is synchronous on the single
// renderer thread, so a module flag is a safe way to pass per-call intent in).
let blockRemote = false

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

    if (blockRemote) neutralizeRemoteContent(node)
  })
}

// Remove the attributes that would fetch a remote image/tracker, leaving inline
// (data:/cid:) references intact. Reached only when the reader asks to block.
function neutralizeRemoteContent(node: Element): void {
  for (const attr of ['src', 'srcset', 'background', 'poster']) {
    if (isRemoteUrl(node.getAttribute(attr))) node.removeAttribute(attr)
  }
  const style = node.getAttribute('style')
  if (style && /url\(/i.test(style)) {
    const cleaned = style.replace(
      /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi,
      (match, _q, url: string) => (isRemoteUrl(url) ? 'url()' : match)
    )
    if (cleaned !== style) node.setAttribute('style', cleaned)
  }
}

/** True when the body references remote (http/protocol-relative) images. */
export function hasRemoteContent(html: string | null | undefined): boolean {
  if (!html) return false
  return (
    /(?:src|srcset|background|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html) ||
    /url\(\s*["']?\s*(?:https?:)?\/\//i.test(html)
  )
}

/**
 * Sanitize an email body for rendering inside the app document.
 *
 * With `blockRemoteContent`, strips remote image/background references so opening
 * the message fires no tracker and leaks no IP — inline (data:/cid:) images are
 * kept. Returns null for empty input so callers can fall back to plain text.
 */
export function sanitizeEmailHtml(
  html: string | null | undefined,
  opts: { blockRemoteContent?: boolean } = {}
): string | null {
  if (!html) return null
  installHook()
  blockRemote = opts.blockRemoteContent === true
  try {
    return DOMPurify.sanitize(html, {
      ADD_ATTR: ['href'],
      FORBID_TAGS,
      FORBID_ATTR
    })
  } finally {
    blockRemote = false
  }
}
