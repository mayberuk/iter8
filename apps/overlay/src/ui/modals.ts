const POINTER_EVENTS = ["pointerdown", "pointerup", "click"] as const

/**
 * Keeps a page's modal from locking the overlay out. Focus traps and outside-click handlers see
 * our shadow UI as a node outside the modal, so its focus and pointer events never reach the page;
 * a native modal `<dialog>` makes everything outside it inert, so the host sits inside the topmost
 * one. A dialog with a transform becomes the containing block of our fixed UI, and the overlay
 * lands off-screen in it.
 */
export function listenPageModals(deps: {
  host: HTMLElement
  root: ShadowRoot
  onHostRemoved: () => void
}): () => void {
  const { host, root, onHostRemoved } = deps
  const html = document.documentElement

  const hideFocus = (event: FocusEvent) => {
    if (
      event.composedPath().includes(host) ||
      (event.type === "focusout" && event.relatedTarget === host)
    )
      event.stopPropagation()
  }
  const stop = (event: Event) => event.stopPropagation()

  window.addEventListener("focusin", hideFocus, { capture: true, passive: true })
  window.addEventListener("focusout", hideFocus, { capture: true, passive: true })
  for (const type of POINTER_EVENTS) root.addEventListener(type, stop, { passive: true })

  const uninert = new MutationObserver(() => {
    host.removeAttribute("inert")
    host.removeAttribute("aria-hidden")
  })
  uninert.observe(host, { attributes: true, attributeFilter: ["inert", "aria-hidden"] })

  let modals = [...document.querySelectorAll<HTMLDialogElement>("dialog:modal")]
  let watched: HTMLDialogElement | null = null

  // A removed dialog or one of its ancestors reports only on its own parent.
  const watchRemoval = new MutationObserver(settle)

  function settle() {
    if (host.parentNode === null) {
      onHostRemoved()
      return
    }
    modals = modals.filter((dialog) => dialog.isConnected && dialog.matches(":modal"))
    const top = modals.at(-1) ?? null
    const parent = top ?? html
    if (host.parentNode !== parent) {
      const focused = root.activeElement
      parent.append(host)
      if (focused instanceof HTMLElement) focused.focus()
    }
    if (top === watched) return
    watched = top
    watchRemoval.disconnect()
    for (let node: Node | null = top; node; node = node.parentNode)
      watchRemoval.observe(node, { childList: true })
  }

  const watchOpen = new MutationObserver((records) => {
    for (const { target } of records) {
      if (
        target instanceof HTMLDialogElement &&
        target.matches(":modal") &&
        !modals.includes(target)
      )
        modals.push(target)
    }
    settle()
  })
  watchOpen.observe(html, { subtree: true, attributes: true, attributeFilter: ["open"] })
  settle()

  return () => {
    window.removeEventListener("focusin", hideFocus, { capture: true })
    window.removeEventListener("focusout", hideFocus, { capture: true })
    for (const type of POINTER_EVENTS) root.removeEventListener(type, stop)
    uninert.disconnect()
    watchOpen.disconnect()
    watchRemoval.disconnect()
  }
}
