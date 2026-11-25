import { describe, expect, test } from "bun:test";
import { REACT_RUNTIME_JS } from "../web/src/indirect-code/components/generative-ui/react-runtime";

type MockNode = {
  nodeType: number;
  tagName?: string;
  namespaceURI?: string;
  nodeValue?: string;
  parentNode: MockNode | null;
  childNodes: MockNode[];
  attrs: Record<string, string>;
  style: Record<string, string>;
  listeners: Record<string, Array<(e: unknown) => void>>;
  firstChild: MockNode | null;
  nextSibling: MockNode | null;
  textContent: string;
  innerHTML: string;
  appendChild(child: MockNode): MockNode;
  insertBefore(child: MockNode, ref: MockNode | null): MockNode;
  removeChild(child: MockNode): MockNode;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
};

function makeNode(nodeType: number, init: { tagName?: string; namespaceURI?: string; nodeValue?: string } = {}): MockNode {
  const node: MockNode = {
    nodeType,
    tagName: init.tagName,
    namespaceURI: init.namespaceURI ?? "http://www.w3.org/1999/xhtml",
    nodeValue: init.nodeValue ?? "",
    parentNode: null,
    childNodes: [],
    attrs: {},
    style: {},
    listeners: {},
    get firstChild() {
      return this.childNodes[0] ?? null;
    },
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
    },
    get textContent(): string {
      if (this.nodeType === 3) return this.nodeValue ?? "";
      if (this.nodeType === 8) return "";
      return this.childNodes.map((c) => c.textContent).join("");
    },
    set textContent(v: string) {
      this.childNodes.forEach((c) => (c.parentNode = null));
      this.childNodes = [];
      if (v) this.appendChild(makeNode(3, { nodeValue: String(v) }));
    },
    get innerHTML(): string {
      return this.textContent;
    },
    set innerHTML(_v: string) {
      this.childNodes.forEach((c) => (c.parentNode = null));
      this.childNodes = [];
    },
    appendChild(child: MockNode) {
      return this.insertBefore(child, null);
    },
    insertBefore(child: MockNode, ref: MockNode | null) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      if (ref == null) {
        this.childNodes.push(child);
      } else {
        const idx = this.childNodes.indexOf(ref);
        if (idx === -1) this.childNodes.push(child);
        else this.childNodes.splice(idx, 0, child);
      }
      return child;
    },
    removeChild(child: MockNode) {
      const idx = this.childNodes.indexOf(child);
      if (idx >= 0) {
        this.childNodes.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = String(v);
    },
    removeAttribute(k: string) {
      delete this.attrs[k];
    },
    addEventListener(type: string, fn: (e: unknown) => void) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      const arr = this.listeners[type];
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
  };
  return node;
}

function bootRuntime() {
  const body = makeNode(1, { tagName: "BODY" });
  const document = {
    body,
    createElement: (tag: string) => makeNode(1, { tagName: tag.toUpperCase() }),
    createElementNS: (ns: string, tag: string) => makeNode(1, { tagName: tag, namespaceURI: ns }),
    createTextNode: (text: string) => makeNode(3, { nodeValue: String(text) }),
    createComment: (text: string) => makeNode(8, { nodeValue: String(text) }),
  };
  const win: Record<string, any> = {
    document,
    __gu: { reportError: (e: unknown) => { throw e; } },
  };
  // Evaluate embedded runtime in an isolated function scope with mock window/document.
  const fn = new Function("window", "document", REACT_RUNTIME_JS);
  fn(win, document);
  const flush = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  return {
    React: win.React as any,
    ReactDOMClient: win.ReactDOMClient as any,
    document,
    body,
    flush,
  };
}

describe("generative-ui embedded React runtime", () => {
  test("createContext / useContext propagates provider updates through deep descendants and React.memo boundaries", async () => {
    const { React, ReactDOMClient, body, flush } = bootRuntime();
    const { createElement: h, createContext, useContext, useState, memo } = React;

    const ThemeCtx = createContext("default");
    let memoRenders = 0;
    let setTheme!: (v: string) => void;
    let setUnrelated!: (n: number) => void;

    function Leaf() {
      const val = useContext(ThemeCtx);
      return h("span", null, `leaf:${val}`);
    }

    const MemoMid = memo(function MemoMid() {
      memoRenders++;
      return h("div", null, h(Leaf, null));
    });

    function App() {
      const [theme, _setTheme] = useState("one");
      const [other, _setOther] = useState(0);
      setTheme = _setTheme;
      setUnrelated = _setOther;
      return h(
        ThemeCtx.Provider,
        { value: theme },
        h(MemoMid, null),
        h(ThemeCtx.Consumer, null, (v: string) => h("em", null, `|consumer:${v}`)),
        h("b", null, `|other:${other}`),
      );
    }

    const root = ReactDOMClient.createRoot(body);
    root.render(h(App, null));
    expect(body.textContent).toBe("leaf:one|consumer:one|other:0");
    expect(memoRenders).toBe(1);

    // Unrelated state update keeps Provider value unchanged -> React.memo bails out cleanly.
    setUnrelated(1);
    await flush();
    expect(body.textContent).toBe("leaf:one|consumer:one|other:1");
    expect(memoRenders).toBe(1);

    // Updating Provider value MUST propagate through MemoMid and Consumer.
    setTheme("two");
    await flush();
    expect(body.textContent).toBe("leaf:two|consumer:two|other:1");
    expect(memoRenders).toBe(2);

    setTheme("three");
    await flush();
    expect(body.textContent).toBe("leaf:three|consumer:three|other:1");
    expect(memoRenders).toBe(3);

    root.unmount();
  });

  test("React.memo and PureComponent allow internal and descendant useState updates without freezing", async () => {
    const { React, ReactDOMClient, body, flush } = bootRuntime();
    const { createElement: h, useState, memo, PureComponent } = React;

    let incMemo!: () => void;
    let incNested!: () => void;
    let setParentTick!: (n: number) => void;
    let memoCount = 0;

    const MemoCounter = memo(function MemoCounter({ label }: { label: string }) {
      memoCount++;
      const [n, setN] = useState(0);
      incMemo = () => setN((x: number) => x + 1);
      return h("span", null, `${label}:${n}`);
    });

    function DeepChild() {
      const [v, setV] = useState(10);
      incNested = () => setV((x: number) => x + 5);
      return h("span", null, `|deep:${v}`);
    }

    class PureWrapper extends PureComponent {
      render() {
        return h("div", null, h(DeepChild, null));
      }
    }

    function App() {
      const [tick, setTick] = useState(0);
      setParentTick = setTick;
      return h("div", null, h(MemoCounter, { label: "cnt" }), h(PureWrapper, { fixed: 1 }), h("i", null, `|t:${tick}`));
    }

    const root = ReactDOMClient.createRoot(body);
    root.render(h(App, null));
    expect(body.textContent).toBe("cnt:0|deep:10|t:0");
    expect(memoCount).toBe(1);

    // Parent re-render with unchanged props: MemoCounter skips render.
    setParentTick(1);
    await flush();
    expect(body.textContent).toBe("cnt:0|deep:10|t:1");
    expect(memoCount).toBe(1);

    // Own useState inside React.memo MUST update DOM.
    incMemo();
    await flush();
    expect(body.textContent).toBe("cnt:1|deep:10|t:1");
    expect(memoCount).toBe(2);

    // Descendant useState inside PureComponent MUST update DOM.
    incNested();
    await flush();
    expect(body.textContent).toBe("cnt:1|deep:15|t:1");

    root.unmount();
  });

  test("unkeyed conditional siblings match positionally and never steal hooks or DOM; keyed items never match unkeyed", async () => {
    const { React, ReactDOMClient, body, flush } = bootRuntime();
    const { createElement: h, useState, useEffect } = React;

    const setters: Record<string, (v: string) => void> = {};
    const unmounted: string[] = [];
    let setShowA!: (v: boolean) => void;

    function Panel({ name }: { name: string }) {
      const [text, setText] = useState(`${name}_init`);
      setters[name] = setText;
      useEffect(() => {
        return () => {
          unmounted.push(name);
        };
      }, [name]);
      return h("p", null, `${name}=${text};`);
    }

    function App() {
      const [showA, _setShowA] = useState(true);
      setShowA = _setShowA;
      return h("section", null, showA ? h(Panel, { name: "A" }) : null, h(Panel, { name: "B" }));
    }

    const root = ReactDOMClient.createRoot(body);
    root.render(h(App, null));
    expect(body.textContent).toBe("A=A_init;B=B_init;");

    setters.A("A_edited");
    setters.B("B_edited");
    await flush();
    expect(body.textContent).toBe("A=A_edited;B=B_edited;");

    // Hiding A must unmount A and keep B's own state intact (NOT steal A's state).
    setShowA(false);
    await flush();
    expect(body.textContent).toBe("B=B_edited;");
    expect(unmounted).toEqual(["A"]);

    // Showing A again mounts fresh A without disturbing B.
    setShowA(true);
    await flush();
    expect(body.textContent).toBe("A=A_init;B=B_edited;");

    root.unmount();
  });

  test("unmatched keyed sibling never steals an unkeyed sibling, and dynamic keyed arrays preserve trailing sibling state", async () => {
    const { React, ReactDOMClient, body, flush } = bootRuntime();
    const { createElement: h, useState } = React;

    let setFooterVal!: (v: string) => void;
    let setItems!: (xs: string[]) => void;

    function Footer() {
      const [val, setVal] = useState("foot0");
      setFooterVal = setVal;
      return h("footer", null, val);
    }

    function App() {
      const [items, _setItems] = useState(["x", "y"]);
      setItems = _setItems;
      return h(
        "div",
        null,
        items.map((id: string) => h("span", { key: id }, `${id},`)),
        h(Footer, null),
      );
    }

    const root = ReactDOMClient.createRoot(body);
    root.render(h(App, null));
    expect(body.textContent).toBe("x,y,foot0");

    setFooterVal("foot_kept");
    await flush();
    expect(body.textContent).toBe("x,y,foot_kept");

    // Growing and reordering the keyed list must keep Footer mounted with its state intact.
    setItems(["y", "z", "x"]);
    await flush();
    expect(body.textContent).toBe("y,z,x,foot_kept");

    root.unmount();
  });

  test("unmatched keyed sibling of same type never falls through and steals an unkeyed sibling", async () => {
    const { React, ReactDOMClient, body, flush } = bootRuntime();
    const { createElement: h, useState } = React;

    const setters: Record<string, (v: string) => void> = {};
    let setKey!: (k: string) => void;

    function Box({ id }: { id: string }) {
      const [val, setVal] = useState(`${id}:0`);
      setters[id] = setVal;
      return h("span", null, `${val}|`);
    }

    function App() {
      const [k, _setKey] = useState("k1");
      setKey = _setKey;
      return h("div", null, h(Box, { key: k, id: k }), h(Box, { id: "unkeyed" }));
    }

    const root = ReactDOMClient.createRoot(body);
    root.render(h(App, null));
    setters.k1("k1:edited");
    setters.unkeyed("unkeyed:edited");
    await flush();
    expect(body.textContent).toBe("k1:edited|unkeyed:edited|");

    // Changing k1 -> k2 must mount fresh k2 and NEVER steal unkeyed's fiber/hooks.
    setKey("k2");
    await flush();
    expect(body.textContent).toBe("k2:0|unkeyed:edited|");

    root.unmount();
  });

  test("findDomParent uses root.__container (not undefined root.dom) for custom mount containers", () => {
    const { React, ReactDOMClient, document } = bootRuntime();
    const { createElement: h } = React;

    const svgContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const root = ReactDOMClient.createRoot(svgContainer);
    root.render(h(React.Fragment, null, h("a", null, "svg-link")));

    // Because svgContainer is in the SVG namespace, a tag-local <a> directly
    // inside a top-level Fragment resolves its namespace through findDomParent ->
    // root.__container (SVG_NS) instead of falling back to HTML document.body.
    const anchor = svgContainer.childNodes.find((n: MockNode) => n.nodeType === 1);
    expect(anchor?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    root.unmount();
  });
});
