;(function () {
  var literal = /^(?:#[0-9a-f]{6}|rgb\(\d{1,3} \d{1,3} \d{1,3} \/ (?:0|0\.\d{1,3})\))$/
  function block(tokens) {
    var css = ''
    for (var name in tokens) {
      if (!/^[a-z-]+$/.test(name) || !literal.test(tokens[name])) return ''
      css += '--' + name + ':' + tokens[name] + ';'
    }
    return css
  }
  function half(scheme, tokens) {
    var body = tokens && block(tokens)
    if (!body) return ''
    return (
      ':root[data-scheme="' +
      scheme +
      '"]{' +
      body +
      '}@media (prefers-color-scheme:' +
      scheme +
      '){:root:not([data-scheme]){' +
      body +
      '}}'
    )
  }
  try {
    var mode = localStorage.getItem('huddle.appearance.mode')
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.scheme = mode
    var paint = JSON.parse(localStorage.getItem('huddle.appearance.paint.v1') || 'null')
    var css = paint ? half('light', paint.light) + half('dark', paint.dark) : ''
    if (css) {
      var sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      document.adoptedStyleSheets = [sheet]
    }
  } catch (e) {}
})()
