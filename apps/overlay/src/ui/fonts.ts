import figtree from "../../assets/fonts/Figtree-Variable.woff2"
import splineSansMono from "../../assets/fonts/SplineSansMono-Variable.woff2"

export function registerFonts(): void {
  const faces = [
    new FontFace("iter8 Figtree", `url(${figtree})`, { weight: "400 800" }),
    new FontFace("iter8 Spline Sans Mono", `url(${splineSansMono})`, { weight: "400 600" }),
  ]
  for (const face of faces) {
    document.fonts.add(face)
    // A failed load leaves the face unusable, so text keeps the system fallback in the token stacks.
    face.load().catch(() => undefined)
  }
}
