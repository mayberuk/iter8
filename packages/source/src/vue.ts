import type { Adapter } from "./lead"

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

export const vueEvidence: Adapter = (element) => {
  const instance: unknown = Reflect.get(element, "__vueParentComponent")
  if (typeof instance !== "object" || instance === null) return null
  const type: unknown = Reflect.get(instance, "type")
  if (typeof type !== "object" && typeof type !== "function") return null
  if (type === null) return null
  const file = stringOf(Reflect.get(type, "__file"))
  if (file === null) return null
  return {
    framework: "vue",
    major: null,
    component: stringOf(Reflect.get(type, "__name")) ?? stringOf(Reflect.get(type, "name")),
    frames: [{ kind: "source", file }],
    onPickedElement: true,
  }
}
