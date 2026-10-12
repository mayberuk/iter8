const STARS = [1, 2, 3, 4, 5]

class RatingElement extends HTMLElement {
  static observedAttributes = ["value", "label"]

  constructor() {
    super()
    this.attachShadow({ mode: "open" })
  }

  connectedCallback() {
    this.render()
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render()
  }

  get value() {
    return Number(this.getAttribute("value") ?? 0)
  }

  set value(next) {
    this.setAttribute("value", String(next))
  }

  render() {
    const label = this.getAttribute("label") ?? "Rating"
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; font-family: inherit; }
        .group { display: inline-flex; gap: 2px; padding: 4px 8px; border-radius: 9999px;
          background: rgb(148 163 184 / 0.15); }
        button { all: unset; cursor: pointer; font-size: 22px; line-height: 1; color: #cbd5e1;
          padding: 2px; border-radius: 4px; }
        button[aria-checked="true"], button.on { color: #dc2626; }
        button:focus-visible { outline: 2px solid #dc2626; outline-offset: 1px; }
      </style>
      <div class="group" role="radiogroup" aria-label="${label}">
        ${STARS.map(
          (star) =>
            `<button type="button" role="radio" data-star="${star}" aria-label="${star} out of 5"
              aria-checked="${star === this.value}" class="${star <= this.value ? "on" : ""}">★</button>`,
        ).join("")}
      </div>`
    for (const button of this.shadowRoot.querySelectorAll("button")) {
      button.addEventListener("click", () => {
        this.value = Number(button.dataset.star)
        this.shadowRoot.querySelector(`[data-star="${this.value}"]`).focus()
        this.dispatchEvent(new CustomEvent("change", { detail: this.value, bubbles: true }))
      })
    }
  }
}

if (!customElements.get("pg-rating")) customElements.define("pg-rating", RatingElement)
