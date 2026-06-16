import assert from 'node:assert/strict';
import test from 'node:test';

function installDocumentMock(onAnchorClick: (href: string) => void) {
  const body = {
    appendChild: () => {},
    removeChild: () => {},
  };
  globalThis.document = {
    createElement: (tag: string) => {
      if (tag === 'a') {
        return {
          href: '',
          style: {},
          rel: '',
          remove: () => {},
          click: function click(this: { href: string }) {
            onAnchorClick(this.href);
          },
        };
      }
      if (tag === 'textarea') {
        return {
          value: '',
          style: {},
          focus: () => {},
          select: () => {},
          setAttribute: () => {},
          remove: () => {},
        };
      }
      throw new Error(`unexpected tag ${tag}`);
    },
    body,
    execCommand: () => true,
  } as unknown as Document;
}

test('openDeeplink 浏览器回退应优先尝试 custom scheme 点击', async () => {
  const clicked: string[] = [];
  const originalDocument = globalThis.document;
  installDocumentMock((href) => clicked.push(href));

  try {
    const { openDeeplink } = await import('../src/lib/openExternal.ts');
    const deeplink = 'cursor://anysphere.cursor-deeplink/mcp/install?name=devfleet&config=e30=';
    const result = await openDeeplink(deeplink, 'https://cursor.com/en/install-mcp?name=devfleet');

    assert.equal(result, null);
    assert.deepEqual(clicked, [deeplink]);
  } finally {
    globalThis.document = originalDocument;
  }
});
