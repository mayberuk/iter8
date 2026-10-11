import jetbrainsMono from "../../assets/fonts/JetBrainsMono-Variable.woff2"
import redditSans from "../../assets/fonts/RedditSans-Variable.woff2"

export function registerFonts(): void {
  const faces = [
    new FontFace("iter8 Reddit Sans", `url(${redditSans})`, { weight: "200 900" }),
    new FontFace("iter8 JetBrains Mono", `url(${jetbrainsMono})`, { weight: "100 800" }),
  ]
  for (const face of faces) {
    document.fonts.add(face)
    // A failed load leaves the face unusable, so text keeps the system fallback in the token stacks.
    face.load().catch(() => undefined)
  }
}
