import { describe, expect, it } from "vitest";
import {
  childrenNamed,
  escapeXml,
  findFirst,
  parseXml,
  valueToXml,
  XmlError,
  xmlToValue,
} from "./xml.js";

/**
 * The XML reader, and specifically the things it refuses.
 *
 * This is hand-written because Node ships no XML parser and the generated
 * TypeScript SDK is zero-dependency by contract. Hand-written XML parsing is
 * exactly where the classic vulnerabilities live, so the design is to be
 * *restricted* rather than defensive: a DTD is the prerequisite for both
 * external-entity expansion and recursive-entity denial of service, and there
 * is no code path here that parses one. These tests assert that absence.
 */
describe("the reader refuses what it cannot safely resolve", () => {
  it("refuses a DOCTYPE outright, which is what makes XXE unparseable", () => {
    const xxe =
      `<?xml version="1.0"?>` +
      `<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
      `<root>&xxe;</root>`;
    expect(() => parseXml(xxe)).toThrow(XmlError);
    expect(() => parseXml(xxe)).toThrow(/DOCTYPE or ENTITY/);
  });

  it("refuses a standalone ENTITY declaration too", () => {
    expect(() => parseXml(`<!ENTITY a "b"><root/>`)).toThrow(XmlError);
  });

  it("refuses the billion-laughs shape for the same reason, not a size check", () => {
    // The defence is structural: this document declares entities, so it is
    // rejected before any expansion is attempted. Nothing here counts bytes.
    const bomb =
      `<!DOCTYPE lolz [<!ENTITY lol "lol">` +
      `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]>` +
      `<lolz>&lol2;</lolz>`;
    expect(() => parseXml(bomb)).toThrow(/DOCTYPE or ENTITY/);
  });

  it("leaves an unknown entity verbatim rather than resolving it", () => {
    // Resolving one would mean consulting a DTD, which is the thing refused.
    const doc = parseXml(`<root>&unknownThing; &amp; done</root>`);
    expect(doc.text).toBe("&unknownThing; & done");
  });

  it("bounds nesting, so depth alone cannot exhaust the stack", () => {
    const deep = `${"<a>".repeat(80)}x${"</a>".repeat(80)}`;
    expect(() => parseXml(deep)).toThrow(/nesting exceeds/);
    expect(() => parseXml(`${"<a>".repeat(10)}x${"</a>".repeat(10)}`)).not.toThrow();
  });

  it("refuses malformed input rather than returning a partial tree", () => {
    // Half-read XML is how a fault gets mistaken for a result.
    expect(() => parseXml("<a><b></a>")).toThrow(XmlError);
    expect(() => parseXml("<a>")).toThrow(XmlError);
    expect(() => parseXml("<a x=unquoted/>")).toThrow(XmlError);
    expect(() => parseXml("")).toThrow(XmlError);
  });
});

describe("the reader handles what a SOAP response actually contains", () => {
  it("reads elements, attributes, text, CDATA, comments and self-closing tags", () => {
    const doc = parseXml(
      `<?xml version="1.0"?><!-- a note -->` +
        `<env:Body xmlns:env="urn:e"><item id="1"><name><![CDATA[a & b]]></name>` +
        `<empty/></item></env:Body>`,
    );
    expect(doc.tag).toBe("env:Body");
    const item = childrenNamed(doc, "item")[0];
    expect(item?.attrs.id).toBe("1");
    expect(childrenNamed(item as never, "name")[0]?.text).toBe("a & b");
    expect(findFirst(doc, "empty")).toBeDefined();
  });

  it("decodes the five predefined entities and numeric references", () => {
    const doc = parseXml(`<a>&lt;tag&gt; &amp; &#65;&#x42;</a>`);
    expect(doc.text).toBe("<tag> & AB");
  });

  it("collects repeated siblings into an array", () => {
    // The commonest way an XML-to-JSON mapping goes wrong: a server returning
    // one item where the contract implies many, or vice versa.
    expect(xmlToValue(parseXml("<r><leg>a</leg><leg>b</leg></r>"))).toEqual({ leg: ["a", "b"] });
    expect(xmlToValue(parseXml("<r><leg>a</leg></r>"))).toEqual({ leg: "a" });
  });

  it("drops namespace declarations from the decoded value", () => {
    expect(xmlToValue(parseXml(`<r xmlns:x="urn:x" id="7"><a>1</a></r>`))).toEqual({
      id: "7",
      a: "1",
    });
  });
});

describe("writing", () => {
  it("escapes every character that could close an element or attribute", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });

  it("cannot be escaped out of by a hostile value", () => {
    const hostile = `</n:Req><evil/><n:Req>`;
    const written = valueToXml(hostile, "note", "n");
    expect(written).toBe(`<n:note>&lt;/n:Req&gt;&lt;evil/&gt;&lt;n:Req&gt;</n:note>`);
    expect(written).not.toContain("<evil");
  });

  it("omits an absent optional field rather than sending an empty tag", () => {
    expect(valueToXml(null, "note", "n")).toBe("");
    expect(valueToXml(undefined, "note", "n")).toBe("");
    expect(valueToXml("", "note", "n")).toBe("<n:note></n:note>");
  });

  it("repeats the element for an array and nests for an object", () => {
    expect(valueToXml([1, 2], "id", "n")).toBe("<n:id>1</n:id><n:id>2</n:id>");
    expect(valueToXml({ a: 1 }, "wrap", "n")).toBe("<n:wrap><n:a>1</n:a></n:wrap>");
  });

  it("round-trips through the reader", () => {
    const written = `<r>${valueToXml({ amount: 100, note: "rent & bills" }, "body", "n")}</r>`;
    expect(xmlToValue(parseXml(written))).toEqual({
      body: { amount: "100", note: "rent & bills" },
    });
  });
});
