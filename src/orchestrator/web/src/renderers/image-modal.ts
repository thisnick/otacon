// Lightweight image modal — renders into <body>, dismissed on backdrop click
// or Escape. No framework, no portal magic.

let openModal: HTMLElement | null = null

function close(): void {
  if (openModal) {
    openModal.remove()
    openModal = null
    document.removeEventListener('keydown', onKey)
  }
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') close()
}

export function openImageModal(url: string, label: string): void {
  close()
  const overlay = document.createElement('div')
  overlay.className = 'image-modal'
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  const inner = document.createElement('div')
  inner.className = 'image-modal-inner'
  inner.innerHTML = `
    <button type="button" class="image-modal-close" aria-label="Close">×</button>
    <figure>
      <img src="${url.replace(/"/g, '&quot;')}" alt="${label}" />
      <figcaption>${label}</figcaption>
    </figure>
  `
  inner.querySelector('.image-modal-close')!.addEventListener('click', close)
  overlay.appendChild(inner)
  document.body.appendChild(overlay)
  document.addEventListener('keydown', onKey)
  openModal = overlay
}
