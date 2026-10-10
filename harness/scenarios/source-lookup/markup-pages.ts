export const INDEX_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Markup that moves lines</title>
</head>
<body>
  <h1>Markup that moves lines</h1>
  <table>
    <tr><td data-source-target="implied-tbody">Cell in an implied tbody</td></tr>
  </table>
  <p>An open paragraph
  <div data-source-target="auto-closed">Div after the paragraph it closed</div>
  <!-- a comment about a <div> that is not one -->
  <div data-source-target="after-comment">Div after a comment</div>
  <script>
    const markup = "<p>not a paragraph</p>"
  </script>
  <p data-source-target="after-script">Paragraph after a script</p>
  <aside data-source-target="multi-line"
    id="side-note"
    class="note"
    title="A start tag
      over three lines"
  >Aside whose start tag spans lines</aside>
  <span>日本語 é</span><em data-source-target="after-non-ascii">Em after non-ASCII text</em>
  <template><p>Paragraph inside a template</p></template>
  <p data-source-target="after-template">Paragraph after a template</p>
</body>
</html>
`

export const SHIFTED_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>A script shifts a sibling</title>
</head>
<body>
  <script>
    document.body.prepend(document.createElement("p"))
  </script>
  <p data-source-target="shifted">Paragraph the script pushed down</p>
  <p>A different paragraph</p>
</body>
</html>
`

export const SUB_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sub page</title>
</head>
<body>
  <main>
    <h2>Sub page</h2>
    <p data-source-target="sub-target">Paragraph in the sub folder</p>
  </main>
</body>
</html>
`

export const CRLF_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Windows line endings</title>
</head>
<body>
  <header>
    <h1>Windows line endings</h1>
  </header>
  <main>
    <p>First paragraph</p>
    <p data-source-target="crlf-target">Second paragraph</p>
  </main>
</body>
</html>
`

export const NESTED_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Shadow roots inside shadow roots</title>
</head>
<body>
  <main>
    <section id="outer-host" class="shell">Outer host text</section>
  </main>
  <script>
    const outer = document.getElementById("outer-host")
    const inner = document.createElement("div")
    inner.id = "inner-host"
    inner.className = "core"
    outer.attachShadow({ mode: "open" }).append(inner)
    const label = document.createElement("span")
    label.textContent = "Nested label"
    inner.attachShadow({ mode: "open" }).append(label)
  </script>
</body>
</html>
`

export const TEXT_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Text the identity reads</title>
</head>
<body>
  <main>
    <div id="folded">  Alpha <b>beta
      gamma</b><template><p>template text</p></template><span id="shadow-host"></span> delta</div>
    <div id="capped"></div>
  </main>
  <script>
    document.getElementById("shadow-host").attachShadow({ mode: "open" }).append("shadow text")
    const capped = document.getElementById("capped")
    for (let count = 0; count < 5000; count += 1) capped.append(document.createTextNode(""))
    capped.append("late text")
  </script>
</body>
</html>
`

export const FRAMEWORK_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Astro source attributes on a folder page</title>
  <script src="data:text/javascript,//@vite/client"></script>
</head>
<body>
  <main>
    <section data-astro-source-file="/work/site/src/pages/index.astro" data-astro-source-loc="7:12">
      <span id="inside">Inside the annotated section</span>
    </section>
  </main>
</body>
</html>
`
