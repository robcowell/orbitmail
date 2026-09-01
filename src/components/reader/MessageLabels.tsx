import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Folder, MessageLabel } from '../../../shared/types'
import { useMailStore, createMailboxForAccount, refreshMessages } from '../../stores/mailStore'
import { Tag, Tray, X, Check, Minus, MagnifyingGlass, PlusCircle } from '../icons'
import { ipcErrorMessage } from '../../utils/ipcError'

// How many of the messages asked about carry a label. Gmail labels a
// conversation, but it also lets one reply carry a label its siblings do not —
// mail filed from the web UI, or a reply that arrived after the filing — so the
// three states are real and the picker shows all three.
type LabelState = 'on' | 'partial' | 'off'

function stateOf(label: MessageLabel | undefined, total: number): LabelState {
  if (!label || label.messageCount === 0) return 'off'
  return label.messageCount >= total ? 'on' : 'partial'
}

/**
 * The labels on the open conversation, and the way to change them.
 *
 * Gmail only, by construction: on every other provider a message lives in one
 * folder, a second copy is a second message, and none of the operations here
 * would mean what the word "label" implies. The row renders nothing at all
 * rather than showing a control that cannot work.
 */
export function MessageLabels({
  accountId,
  messageIds
}: {
  accountId: string
  messageIds: string[]
}) {
  const accounts = useMailStore((s) => s.accounts)
  const setToast = useMailStore((s) => s.setToast)
  const isGmail = accounts.find((a) => a.id === accountId)?.provider === 'gmail'

  const [labels, setLabels] = useState<MessageLabel[]>([])
  const [available, setAvailable] = useState<Folder[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  // The label being written right now, so its row can say so and a second
  // click cannot start a duplicate COPY.
  const [busyFolderId, setBusyFolderId] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // `messageIds` is a fresh array on every render of the parent, so the effects
  // below key off its contents rather than its identity.
  const idKey = messageIds.join(',')

  const load = useCallback(async () => {
    if (!isGmail || messageIds.length === 0) return
    try {
      setLabels(await window.orbitMail.messages.labels(messageIds))
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Could not read labels'))
    }
    // messageIds is covered by idKey, which the caller of `load` depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey, isGmail, setToast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!pickerOpen) return
    let cancelled = false
    void (async () => {
      try {
        const folders = await window.orbitMail.messages.availableLabels(accountId)
        if (!cancelled) setAvailable(folders)
      } catch (err) {
        if (!cancelled) setToast(ipcErrorMessage(err, 'Could not list labels'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pickerOpen, accountId, setToast])

  // Opening the picker puts the caret in the search box: the fast path is type
  // two letters and hit the label, not hunt a list that can be forty long.
  useEffect(() => {
    if (pickerOpen) searchRef.current?.focus()
  }, [pickerOpen])

  useEffect(() => {
    if (!pickerOpen) return
    const onMouseDown = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [pickerOpen])

  const byFolderId = useMemo(
    () => new Map(labels.map((label) => [label.folderId, label])),
    [labels]
  )

  const trimmedQuery = query.trim()
  const matches = useMemo(() => {
    const needle = trimmedQuery.toLocaleLowerCase()
    return available
      .filter((folder) => !needle || folder.name.toLocaleLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [available, trimmedQuery])

  // Only offer to create when nothing already answers to that name — offering
  // "Create Work" under an existing Work is how duplicate labels get made.
  const canCreate =
    trimmedQuery.length > 0 &&
    !available.some((f) => f.name.toLocaleLowerCase() === trimmedQuery.toLocaleLowerCase())

  const apply = async (folderId: string, next: 'add' | 'remove') => {
    setBusyFolderId(folderId)
    try {
      const result =
        next === 'add'
          ? await window.orbitMail.messages.addLabel(messageIds, folderId)
          : await window.orbitMail.messages.removeLabel(messageIds, folderId)
      if (result.failed > 0) {
        setToast(
          result.changed > 0
            ? `${result.changed} changed, ${result.failed} failed`
            : 'The server refused the label change'
        )
      }
      await load()
      // A label change adds or removes a row, which the open list may be
      // showing: labelling out of a label's own folder empties the row the user
      // is looking at.
      await refreshMessages()
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Label change failed'))
    } finally {
      setBusyFolderId(null)
    }
  }

  const createAndApply = async () => {
    const name = trimmedQuery
    try {
      await createMailboxForAccount(accountId, name)
      const folders = await window.orbitMail.messages.availableLabels(accountId)
      setAvailable(folders)
      const created = folders.find((f) => f.name.toLocaleLowerCase() === name.toLocaleLowerCase())
      if (!created) {
        setToast(`Created “${name}”, but it did not come back as a label`)
        return
      }
      setQuery('')
      await apply(created.id, 'add')
    } catch {
      // createMailboxForAccount has already said what went wrong.
    }
  }

  if (!isGmail || messageIds.length === 0) return null

  return (
    <div className="reader-labels">
      <Tag size={14} weight="duotone" className="reader-labels-icon" />

      {labels.map((label) => {
        const state = stateOf(label, messageIds.length)
        return (
          <span
            key={label.folderId}
            className={`label-chip${state === 'partial' ? ' partial' : ''}`}
            title={
              state === 'partial'
                ? `On ${label.messageCount} of ${messageIds.length} messages`
                : label.imapPath
            }
          >
            {label.isInbox && <Tray size={12} weight="duotone" />}
            <span className="label-chip-name">{label.name}</span>
            <button
              type="button"
              className="label-chip-remove"
              // Removing Gmail's Inbox label *is* archiving, and saying so is
              // the difference between a button people trust and one they
              // avoid.
              title={label.isInbox ? 'Archive (remove the Inbox label)' : `Remove “${label.name}”`}
              aria-label={
                label.isInbox ? 'Archive (remove the Inbox label)' : `Remove ${label.name}`
              }
              disabled={busyFolderId === label.folderId}
              onClick={() => void apply(label.folderId, 'remove')}
            >
              <X size={10} weight="bold" />
            </button>
          </span>
        )
      })}

      <div className="label-picker-wrap" ref={pickerRef}>
        <button
          type="button"
          className="label-add-btn"
          title="Add or remove labels"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
        >
          <PlusCircle size={13} weight="duotone" />
          Label
        </button>

        {pickerOpen && (
          <div className="label-picker">
            <div className="label-picker-search">
              <MagnifyingGlass size={13} weight="duotone" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder="Search labels"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // Enter takes the obvious action: the single match if the
                  // search has narrowed to one, otherwise the new label.
                  if (event.key !== 'Enter') return
                  if (matches.length === 1) {
                    const only = matches[0]
                    const state = stateOf(byFolderId.get(only.id), messageIds.length)
                    void apply(only.id, state === 'on' ? 'remove' : 'add')
                  } else if (canCreate) {
                    void createAndApply()
                  }
                }}
              />
            </div>

            <div className="label-picker-list">
              {matches.map((folder) => {
                const state = stateOf(byFolderId.get(folder.id), messageIds.length)
                return (
                  <button
                    key={folder.id}
                    type="button"
                    className="label-picker-item"
                    disabled={busyFolderId === folder.id}
                    onClick={() => void apply(folder.id, state === 'on' ? 'remove' : 'add')}
                    title={folder.imapPath}
                  >
                    <span className={`label-check ${state}`}>
                      {state === 'on' && <Check size={11} weight="bold" />}
                      {state === 'partial' && <Minus size={11} weight="bold" />}
                    </span>
                    <span className="label-picker-name">{folder.name}</span>
                  </button>
                )
              })}
              {matches.length === 0 && !canCreate && (
                <div className="label-picker-empty">No labels</div>
              )}
            </div>

            {canCreate && (
              <button type="button" className="label-picker-create" onClick={() => void createAndApply()}>
                <PlusCircle size={13} weight="duotone" />
                Create “{trimmedQuery}”
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
