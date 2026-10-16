import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeOrgUrl, loadConfig } from "../src/config.ts";
import { branchRef, compact, htmlToText, identityName, shortRef, textToHtml, wiqlString } from "../src/format.ts";

test("htmlToText keeps structure and decodes entities", () => {
  const html =
    "<div>Steps:</div><ol><li>Open <b>login</b></li><li>Click &quot;Save&quot;&nbsp;&amp; wait</li></ol>" +
    '<p>See <a href="https://example.com/x">the spec</a> and <a href="#" data-vss-mention="1">@Jane Doe</a></p>' +
    '<img src="https://example.com/a.png"><br>Done &#8211; ok &#x1F600;';
  assert.equal(
    htmlToText(html),
    'Steps:\n\n- Open login\n- Click "Save" & wait\nSee the spec (https://example.com/x) and @Jane Doe\n' +
      "[image: https://example.com/a.png]\nDone – ok 😀",
  );
});

test("htmlToText ignores empty and non-string values", () => {
  assert.equal(htmlToText(undefined), "");
  assert.equal(htmlToText(3), "");
  assert.equal(htmlToText(""), "");
});

test("textToHtml escapes markup and keeps line breaks", () => {
  assert.equal(textToHtml('a < b & "c"\nnext'), "a &lt; b &amp; &quot;c&quot;<br>next");
});

test("identityName formats identity objects", () => {
  assert.equal(identityName({ displayName: "Jane Doe", uniqueName: "jane@contoso.com" }), "Jane Doe <jane@contoso.com>");
  assert.equal(identityName({ displayName: "Build Service", uniqueName: "Build Service" }), "Build Service");
  assert.equal(identityName("someone"), "someone");
  assert.equal(identityName(null), undefined);
});

test("branch helpers", () => {
  assert.equal(branchRef("main"), "refs/heads/main");
  assert.equal(branchRef("refs/tags/v1"), "refs/tags/v1");
  assert.equal(shortRef("refs/heads/feature/x"), "feature/x");
});

test("compact drops empty values", () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null, d: "", e: [], f: 0, g: false }), { a: 1, f: 0, g: false });
});

test("wiqlString escapes quotes", () => {
  assert.equal(wiqlString("O'Brien"), "'O''Brien'");
});

test("normalizeOrgUrl accepts names and URLs", () => {
  assert.equal(normalizeOrgUrl("contoso"), "https://dev.azure.com/contoso");
  assert.equal(normalizeOrgUrl("https://dev.azure.com/contoso/"), "https://dev.azure.com/contoso");
  assert.equal(normalizeOrgUrl("https://tfs.local/tfs/DefaultCollection"), "https://tfs.local/tfs/DefaultCollection");
  assert.throws(() => normalizeOrgUrl("contoso/project"));
});

test("loadConfig reads arguments before environment", () => {
  const config = loadConfig({ AZURE_DEVOPS_ORG: "from-env", AZURE_DEVOPS_PROJECT: " Web ", AZURE_DEVOPS_PAT: "x" }, [
    "from-arg",
    "--read-only",
  ]);
  assert.deepEqual(config, {
    orgUrl: "https://dev.azure.com/from-arg",
    defaultProject: "Web",
    pat: "x",
    readOnly: true,
  });
  assert.equal(loadConfig({ AZURE_DEVOPS_ORG: "o", AZURE_DEVOPS_READ_ONLY: "false" }, []).readOnly, false);
  assert.throws(() => loadConfig({}, []), /No organization/);
});
