import { describe, expect, test } from "bun:test";
import { renderFallback } from "../src/demo/fallback";

const BUILT_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>HARNESS — live demo</title>
    <meta name="description" content="HARNESS running in your browser." />
    <script type="module" crossorigin src="./assets/demo-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/demo-def456.css">
  </head>
  <body>
    <div id="root"></div>
    <script>window.__HARNESS_DEMO__ = true;</script>
  </body>
</html>
`;

describe("demo fallback document — a deep link or a reload must boot the app", () => {
  test("never carries the relative asset paths that break below the app root", () => {
    const html = renderFallback(BUILT_INDEX);
    expect(html).not.toMatch(/(src|href)="\.\/assets\//);
    expect(html).toContain("demo-abc123.js");
    expect(html).toContain("demo-def456.css");
    expect(html).toContain('var JS = "assets/demo-abc123.js"');
    expect(html).toContain('var CSS = "assets/demo-def456.css"');
  });

  test("probes the deploy prefix before the domain root, so /<repo>/<route> resolves", () => {
    const html = renderFallback(BUILT_INDEX);
    expect(html).toContain('var candidates = segs.length ? ["/" + segs[0] + "/", "/"] : ["/"]');
    expect(html).toContain("fetch(root + JS");
    expect(html).toContain("if (res && res.ok) boot(root)");
    expect(html).toContain("next(i + 1)");
  });

  test("publishes the resolved root as <base> so the app router reads the same mount point", () => {
    const html = renderFallback(BUILT_INDEX);
    expect(html).toContain('var base = document.createElement("base")');
    expect(html).toContain("base.href = root;");
    expect(html).toContain('tag.type = "module"');
    expect(html).toContain("tag.src = root + JS;");
  });

  test("keeps the document identity and the mount point", () => {
    const html = renderFallback(BUILT_INDEX);
    expect(html).toContain("<title>HARNESS — live demo</title>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain("window.__HARNESS_DEMO__ = true;");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("a miss says so and offers the way back instead of a blank page", () => {
    const html = renderFallback(BUILT_INDEX);
    expect(html).toContain("This address is not part of the demo.");
    expect(html).toContain('href="\' + home + \'"');
  });

  test("the inline loader is syntactically valid JavaScript", () => {
    const html = renderFallback(BUILT_INDEX);
    const inline = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
    expect(() => new Function(inline)).not.toThrow();
  });

  test("a build with no module entry is rejected rather than shipped", () => {
    expect(() => renderFallback("<html><body><div id=\"root\"></div></body></html>")).toThrow(
      "no module entry script",
    );
  });
});
