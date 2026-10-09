class FixtureShadowLabel extends HTMLElement {
  constructor() {
    super()
    const root = this.attachShadow({ mode: "open" })
    const label = document.createElement("span")
    label.dataset.fixture = "shadow-label"
    label.textContent = "Shadow label in static"
    root.append(label)
  }
}

customElements.define("fixture-shadow-label", FixtureShadowLabel)
