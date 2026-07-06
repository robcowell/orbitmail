import { useEffect, useRef, useState } from 'react'
import { TextB } from '@phosphor-icons/react/dist/ssr/TextB'
import { TextItalic } from '@phosphor-icons/react/dist/ssr/TextItalic'
import { TextUnderline } from '@phosphor-icons/react/dist/ssr/TextUnderline'
import { TextStrikethrough } from '@phosphor-icons/react/dist/ssr/TextStrikethrough'
import { ListBullets } from '@phosphor-icons/react/dist/ssr/ListBullets'
import { ListNumbers } from '@phosphor-icons/react/dist/ssr/ListNumbers'
import { LinkSimple } from '@phosphor-icons/react/dist/ssr/LinkSimple'
import { Quotes } from '@phosphor-icons/react/dist/ssr/Quotes'
import { Code } from '@phosphor-icons/react/dist/ssr/Code'
import { TextAlignLeft } from '@phosphor-icons/react/dist/ssr/TextAlignLeft'
import { TextAlignCenter } from '@phosphor-icons/react/dist/ssr/TextAlignCenter'
import { TextAlignRight } from '@phosphor-icons/react/dist/ssr/TextAlignRight'
import { Palette } from '@phosphor-icons/react/dist/ssr/Palette'
import { Eraser } from '@phosphor-icons/react/dist/ssr/Eraser'

interface RichTextEditorProps {
  /** Initial HTML, applied once on mount (the editor is otherwise uncontrolled). */
  initialHtml: string
  onChange: (html: string, text: string) => void
  placeholder?: string
}

const BTN = { size: 16, weight: 'bold' as const }

// A contentEditable rich-text editor with an extended formatting toolbar. It is
// uncontrolled — the DOM is the source of truth — so React never re-writes the
// innerHTML while typing (which would reset the caret). Remount it (via `key`)
// to load fresh content.
export function RichTextEditor({ initialHtml, onChange, placeholder }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const savedRange = useRef<Range | null>(null)
  const colorInputRef = useRef<HTMLInputElement>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    el.innerHTML = initialHtml
    setEmpty(el.innerText.trim().length === 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const emit = () => {
    const el = editorRef.current
    if (!el) return
    const text = el.innerText
    setEmpty(text.trim().length === 0)
    onChange(el.innerHTML, text)
  }

  const focusEditor = () => editorRef.current?.focus()

  const exec = (command: string, value?: string) => {
    focusEditor()
    document.execCommand(command, false, value)
    emit()
  }

  const saveSelection = () => {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange()
    }
  }

  const restoreSelection = () => {
    const range = savedRange.current
    if (!range) return
    focusEditor()
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  const applyLink = () => {
    const url = linkUrl.trim()
    setLinkOpen(false)
    setLinkUrl('')
    if (!url) return
    const href = /^https?:\/\/|^mailto:/i.test(url) ? url : `https://${url}`
    restoreSelection()
    document.execCommand('createLink', false, href)
    emit()
  }

  const insertCode = () => {
    focusEditor()
    const selected = window.getSelection()?.toString() ?? ''
    const escaped = selected.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    document.execCommand('insertHTML', false, `<code>${escaped || '​'}</code>`)
    emit()
  }

  const clearFormatting = () => {
    focusEditor()
    document.execCommand('removeFormat')
    document.execCommand('formatBlock', false, '<p>')
    emit()
  }

  // Keep toolbar clicks from stealing focus / collapsing the selection.
  const hold = (e: React.MouseEvent) => e.preventDefault()

  return (
    <div className="rte">
      <div className="rte-toolbar" role="toolbar" aria-label="Formatting">
        <select
          className="rte-select"
          aria-label="Paragraph style"
          defaultValue="p"
          onMouseDown={saveSelection}
          onChange={(e) => {
            exec('formatBlock', `<${e.target.value}>`)
            e.currentTarget.value = 'p'
          }}
        >
          <option value="p">Normal</option>
          <option value="h1">Heading</option>
          <option value="h2">Subheading</option>
          <option value="h3">Small heading</option>
        </select>

        <span className="rte-sep" />

        <button type="button" className="rte-btn" title="Bold (Ctrl+B)" onMouseDown={hold} onClick={() => exec('bold')}>
          <TextB {...BTN} />
        </button>
        <button type="button" className="rte-btn" title="Italic (Ctrl+I)" onMouseDown={hold} onClick={() => exec('italic')}>
          <TextItalic {...BTN} />
        </button>
        <button type="button" className="rte-btn" title="Underline (Ctrl+U)" onMouseDown={hold} onClick={() => exec('underline')}>
          <TextUnderline {...BTN} />
        </button>
        <button type="button" className="rte-btn" title="Strikethrough" onMouseDown={hold} onClick={() => exec('strikeThrough')}>
          <TextStrikethrough {...BTN} />
        </button>

        <span className="rte-sep" />

        <button type="button" className="rte-btn" title="Align left" onMouseDown={hold} onClick={() => exec('justifyLeft')}>
          <TextAlignLeft {...BTN} />
        </button>
        <button type="button" className="rte-btn" title="Align center" onMouseDown={hold} onClick={() => exec('justifyCenter')}>
          <TextAlignCenter {...BTN} />
        </button>
        <button type="button" className="rte-btn" title="Align right" onMouseDown={hold} onClick={() => exec('justifyRight')}>
          <TextAlignRight {...BTN} />
        </button>

        <span className="rte-sep" />

        <button
          type="button"
          className="rte-btn"
          title="Text colour"
          onMouseDown={(e) => {
            hold(e)
            saveSelection()
          }}
          onClick={() => colorInputRef.current?.click()}
        >
          <Palette {...BTN} />
        </button>
        <input
          ref={colorInputRef}
          type="color"
          className="rte-color-input"
          aria-label="Text colour"
          onChange={(e) => {
            restoreSelection()
            document.execCommand('foreColor', false, e.target.value)
            emit()
          }}
        />

        <button type="button" className="rte-btn" title="Bulleted list" onMouseDown={hold} onClick={() => exec('insertUnorderedList')}>
          <ListBullets {...BTN} />
        </button>
        <button type="button" className="rte-btn" title="Numbered list" onMouseDown={hold} onClick={() => exec('insertOrderedList')}>
          <ListNumbers {...BTN} />
        </button>

        <span className="rte-sep" />

        <button
          type="button"
          className={`rte-btn${linkOpen ? ' is-active' : ''}`}
          title="Insert link"
          onMouseDown={(e) => {
            hold(e)
            saveSelection()
          }}
          onClick={() => setLinkOpen((o) => !o)}
        >
          <LinkSimple {...BTN} />
        </button>
        <button type="button" className="rte-btn" title="Quote" onMouseDown={hold} onClick={() => exec('formatBlock', '<blockquote>')}>
          <Quotes {...BTN} />
        </button>
        <button type="button" className="rte-btn" title="Inline code" onMouseDown={hold} onClick={insertCode}>
          <Code {...BTN} />
        </button>
        <button type="button" className="rte-btn" title="Clear formatting" onMouseDown={hold} onClick={clearFormatting}>
          <Eraser {...BTN} />
        </button>
      </div>

      {linkOpen && (
        <div className="rte-link-popover">
          <input
            className="rte-link-input"
            type="text"
            placeholder="https://example.com"
            value={linkUrl}
            autoFocus
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyLink()
              } else if (e.key === 'Escape') {
                setLinkOpen(false)
                setLinkUrl('')
              }
            }}
          />
          <button type="button" className="btn btn-secondary rte-link-apply" onMouseDown={hold} onClick={applyLink}>
            Add
          </button>
        </div>
      )}

      <div
        ref={editorRef}
        className="rte-editor"
        contentEditable
        role="textbox"
        aria-multiline="true"
        data-empty={empty}
        data-placeholder={placeholder ?? 'Write your message…'}
        onInput={emit}
        suppressContentEditableWarning
      />
    </div>
  )
}
