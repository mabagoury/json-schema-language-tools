import { findNodeAtLocation, findNodeAtOffset, parseTree, getNodePath } from "jsonc-parser";
import * as JsonPointer from "@hyperjump/json-pointer";
import { getKeywordId } from "@hyperjump/json-schema/experimental";
import { find, some } from "@hyperjump/pact";
import { toAbsoluteUri } from "./util.js";


export class JsoncInstance {
  constructor(textDocument, root, node, pointer, annotations) {
    this.textDocument = textDocument;
    this.root = root;
    this.node = node;
    this.pointer = pointer;
    this.annotations = annotations;
  }

  static fromTextDocument(textDocument) {
    const json = textDocument.getText();
    const root = parseTree(json, [], {
      disallowComments: false,
      allowTrailingComma: true,
      allowEmptyContent: true
    });

    return new JsoncInstance(textDocument, root, root, "", {});
  }

  uri() {
    return this;
  }

  value() {
    if (this.node === undefined) {
      return undefined;
    } else if (this.node.value === undefined) {
      const json = this.textDocument.getText().slice(this.node.offset, this.node.offset + this.node.length);
      return JSON.parse(json);
    } else {
      return this.node.value;
    }
  }

  has(key) {
    return some((propertyName) => propertyName.value() === key, this.keys());
  }

  typeOf() {
    return this.node?.type ?? "undefined";
  }

  step(propertyName) {
    const pair = find(([key]) => key.value() === propertyName, this.entries());
    return pair ? pair[1] : new JsoncInstance(this.textDocument, this.root, undefined, JsonPointer.append(propertyName, this.pointer, this.annotations));
  }

  * entries() {
    if (this.typeOf() !== "object") {
      return;
    }

    for (const propertyNode of this.node.children) {
      if (!propertyNode.children[1]) {
        continue;
      }
      const propertyName = propertyNode.children[0].value;
      const pointer = JsonPointer.append(propertyName, this.pointer);
      yield [
        new JsoncInstance(this.textDocument, this.root, propertyNode.children[0], pointer, this.annotations),
        new JsoncInstance(this.textDocument, this.root, propertyNode.children[1], pointer, this.annotations)
      ];
    }
  }

  * iter() {
    if (this.typeOf() !== "array") {
      return;
    }

    for (let itemIndex = 0; itemIndex < this.node.children.length; itemIndex++) {
      const itemNode = this.node.children[itemIndex];
      const pointer = JsonPointer.append(`${itemIndex}`, this.pointer);
      yield new JsoncInstance(this.textDocument, this.root, itemNode, pointer, this.annotations);
    }
  }

  * keys() {
    if (this.typeOf() !== "object") {
      return;
    }

    for (const propertyNode of this.node.children) {
      const propertyNameNode = propertyNode.children[0];
      const pointer = JsonPointer.append(propertyNameNode.value, this.pointer);
      yield new JsoncInstance(this.textDocument, this.root, propertyNameNode, pointer, this.annotations);
    }
  }

  * values() {
    if (this.typeOf() !== "object") {
      return;
    }

    for (const propertyNode of this.node.children) {
      const propertyName = propertyNode.children[0].value;
      const pointer = JsonPointer.append(propertyName, this.pointer);
      yield new JsoncInstance(this.textDocument, this.root, propertyNode.children[1], pointer, this.annotations);
    }
  }

  length() {
    if (this.typeOf() !== "array") {
      return;
    }

    return this.node.children.length;
  }

  get(uri = "") {
    if (uri[0] !== "#") {
      throw Error(`No JSON document found at '${toAbsoluteUri(uri)}'`);
    }

    const pointer = decodeURI(uri.substring(1));
    const node = findNodeAtLocation(this.root, [...pointerSegments(pointer)]);
    return new JsoncInstance(this.textDocument, this.root, node, pointer, this.annotations);
  }

  asEmbedded() {
    const instance = new JsoncInstance(this.textDocument, this.node, this.node, "", {});

    const parent = this.node.parent;
    const index = parent.type === "property" ? 1 : parent.children.findIndex((node) => node === this.node);
    parent.children[index] = {
      type: "boolean",
      offset: this.node.offset,
      length: 0
    };

    return instance;
  }

  annotation(keyword, dialectId = "https://json-schema.org/draft/2020-12/schema") {
    const keywordId = getKeywordId(keyword, dialectId);
    return this.annotations[this.pointer]?.[keywordId] || [];
  }

  annotate(keyword, value) {
    const instance = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    instance.annotations = {
      ...this.annotations,
      [this.pointer]: {
        ...this.annotations[this.pointer],
        [keyword]: [
          value,
          ...this.annotations[this.pointer]?.[keyword] || []
        ]
      }
    };

    return instance;
  }

  annotatedWith(keyword, dialectId = "https://json-schema.org/draft/2020-12/schema") {
    const instances = [];

    const keywordId = getKeywordId(keyword, dialectId);
    for (const instancePointer in this.annotations) {
      if (keywordId in this.annotations[instancePointer]) {
        instances.push(this.get(`#${instancePointer}`));
      }
    }

    return instances;
  }

  parent() {
    return new JsoncInstance(this.textDocument, this.root, this.node.parent, this.pointer, this.annotations);
  }

  startPosition() {
    return this.textDocument.positionAt(this.node.offset);
  }

  endPosition() {
    return this.textDocument.positionAt(this.node.offset + this.node.length);
  }

  textLength() {
    return this.node.length;
  }

  getInstanceAtPosition(position) {
    const offset = this.textDocument.offsetAt(position);
    const node = findNodeAtOffset(this.root, offset);
    if (node) {
      const pathToNode = getNodePath(node);
      const pointer = pathToNode.reduce((pointer, segment) => JsonPointer.append(segment, pointer), "");
      return new JsoncInstance(this.textDocument, this.root, node, pointer, this.annotations);
    } else {
      return new JsoncInstance(this.textDocument, this.root, undefined, "", this.annotations);
    }
  }
}

const pointerSegments = function* (pointer) {
  if (pointer.length > 0 && pointer[0] !== "/") {
    throw Error(`Invalid JSON Pointer: '${pointer}'`);
  }

  let segmentStart = 1;
  let segmentEnd = 0;

  while (segmentEnd < pointer.length) {
    const position = pointer.indexOf("/", segmentStart);
    segmentEnd = position === -1 ? pointer.length : position;
    const segment = pointer.slice(segmentStart, segmentEnd);
    segmentStart = segmentEnd + 1;

    yield segment.toString().replace(/~1/g, "/").replace(/~0/g, "~");
  }
};
