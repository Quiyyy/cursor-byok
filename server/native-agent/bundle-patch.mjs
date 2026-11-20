import {parse} from '../../apps/desktop/node_modules/@babel/parser/lib/index.js';
import tm from '../../apps/desktop/node_modules/@babel/traverse/lib/index.js';

const traverse = tm.default ?? tm;

// All locators see the original offsets and share Babel's lexical scopes.
export class BundlePatch {
  constructor(source) {
    this.source = source;
    this.ast = parse(source);
    this.edits = [];
  }

  visit(visitor) {
    traverse(this.ast, visitor);
  }

  visitNodes(type, visit) {
    traverse.cheap(this.ast, node => {
      if (node.type === type) visit(node);
    });
  }

  // A webpack factory owns its parameters and the classes declared inside it.
  // Build bindings for that factory with its original nodes and source offsets.
  withFactoryScope(factory, inspect) {
    const wrapper = parse('({})');
    wrapper.program.body[0].expression.properties.push(factory);
    traverse(wrapper, {ObjectMethod(path) {
      if (path.node === factory) {
        inspect(path);
        path.stop();
      }
    }});
  }

  replace(start, end, code) {
    this.edits.push({start, end, code});
  }

  apply() {
    let boundary = this.source.length;
    const parts = [];
    for (const {start, end, code} of this.edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
      if (end > boundary || end < start) throw Error('Overlapping Cursor patch locations');
      parts.push(this.source.slice(end, boundary), code);
      boundary = start;
    }
    parts.push(this.source.slice(0, boundary));
    return parts.reverse().join('');
  }
}
