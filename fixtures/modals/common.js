window.__pageClicks = 0
document.getElementById("open").addEventListener("click", () => window.__open())
document.getElementById("close").addEventListener("click", () => window.__close())
document.getElementById("page-button").addEventListener("click", () => {
  window.__pageClicks += 1
})
