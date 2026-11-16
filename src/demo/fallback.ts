import { readFileSync, writeFileSync } from "node:fs";

/**
 * The static demo is served from a project sub-path (/<repo>/), so its assets are
 * referenced relatively ("./assets/app.js") and resolve correctly from the app root.
 * A host's 404 page, by contrast, is delivered at *any* depth: /<repo>/runs/run_123
 * would resolve "./assets/app.js" against /<repo>/runs/ and fetch nothing, so a deep
 * link or a reload rendered a blank page. This module builds the 404 document that
 * finds the deploy prefix at runtime (probe /<first-segment>/ then /), publishes it as
 * <base> so the app's own router reads the same mount point, and injects the bundle
 * absolutely. If neither candidate holds the bundle it says so instead of going blank.
 */
export function renderFallback(indexHtml: string): string {
  const scriptSrc = indexHtml.match(/<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/)?.[1];
  if (!scriptSrc) throw new Error("fallback: index.html has no module entry script");
  const styleHref = indexHtml.match(/<link[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/)?.[1] ?? "";
  const title = (indexHtml.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "demo").trim();
  const description = (indexHtml.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "").trim();
  const lang = (indexHtml.match(/<html[^>]*\blang="([^"]+)"/)?.[1] ?? "en").trim();
  const js = stripLeadingDotSlash(scriptSrc);
  const css = stripLeadingDotSlash(styleHref);

  return [
    "<!doctype html>",
    `<html lang="${lang}">`,
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <meta name="color-scheme" content="dark" />',
    `    <title>${title}</title>`,
    ...(description ? [`    <meta name="description" content="${description}" />`] : []),
    "    <script>",
    "      (function () {",
    `        var JS = ${JSON.stringify(js)};`,
    `        var CSS = ${JSON.stringify(css)};`,
    '        var segs = location.pathname.split("/").filter(Boolean);',
    '        var home = segs.length ? "/" + segs[0] + "/" : "/";',
    '        var candidates = segs.length ? ["/" + segs[0] + "/", "/"] : ["/"];',
    "        function boot(root) {",
    '          var base = document.createElement("base");',
    "          base.href = root;",
    "          document.head.appendChild(base);",
    "          if (CSS) {",
    '            var link = document.createElement("link");',
    '            link.rel = "stylesheet";',
    "            link.href = root + CSS;",
    "            document.head.appendChild(link);",
    "          }",
    '          var tag = document.createElement("script");',
    '          tag.type = "module";',
    "          tag.src = root + JS;",
    "          document.head.appendChild(tag);",
    "        }",
    "        function fail() {",
    '          var root = document.getElementById("root");',
    "          if (!root) return;",
    '          root.style.cssText = "padding:3rem 1.5rem;font:16px/1.5 system-ui,sans-serif;max-width:34rem";',
    '          root.innerHTML = \'<h1 style="font-size:1.25rem;margin:0 0 .75rem">This address is not part of the demo.</h1>\' +',
    '            \'<p style="margin:0 0 1rem">The app itself is fine \\u2014 the page you asked for was not found where it was served from.</p>\' +',
    '            \'<p style="margin:0"><a style="color:inherit" href="\' + home + \'">Open the demo home</a></p>\'; ',
    "        }",
    "        function next(i) {",
    "          if (i >= candidates.length) return fail();",
    "          var root = candidates[i];",
    "          fetch(root + JS, { method: \"HEAD\" })",
    "            .then(function (res) { if (res && res.ok) boot(root); else next(i + 1); })",
    "            .catch(function () { next(i + 1); });",
    "        }",
    "        next(0);",
    "      })();",
    "    </script>",
    "  </head>",
    "  <body>",
    '    <div id="root"></div>',
    '    <script>window.__HARNESS_DEMO__ = true;</script>',
    "    <noscript>HARNESS needs JavaScript. The server build serves the same app over HTTP.</noscript>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

function stripLeadingDotSlash(p: string): string {
  return p.replace(/^\.\//, "");
}

if (import.meta.main) {
  const [, , from = "demo/index.html", to = "demo/404.html"] = process.argv;
  const source = readFileSync(from, "utf8");
  writeFileSync(to, renderFallback(source));
  process.stdout.write(`fallback: ${to} boots the app from any depth\n`);
}
