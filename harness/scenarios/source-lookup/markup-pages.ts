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
